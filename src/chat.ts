import { Hono } from "hono";
import { z } from "zod";

import { hasExactBrowserOrigin, readBrowserUser } from "./auth/browser.ts";
import type { AppDatabase } from "./db.ts";
import type { AgentLog } from "./logging/agents.ts";
import { addressExists, formatAddress, parseAddress } from "./forum/addresses.ts";
import { isProjectMember } from "./projects.ts";
import type { ServiceAccess } from "./service-access/services.ts";
import type { ProjectSandboxIdentity } from "./sandbox/lifecycle.ts";
import {
  runScribe,
  SCRIBE_HISTORY_MESSAGE_LIMIT,
  type ScribeHistoryMessage,
  type ScribeSelection,
  type ScribeToolActivity,
} from "./scribe.ts";

const createConversationInput = z.object({
  anchor: z.string().trim().max(100).nullable().optional(),
}).strict();

const replyInput = z.object({
  body: z.string().trim().min(1).max(100_000),
  provider: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  model: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).default("off"),
}).strict();

function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function messageReferences(body: string): string[] {
  const references = new Set<string>();
  for (const match of body.matchAll(/\[\[([^\[\]]+)\]\]/g)) {
    const parsed = parseAddress(match[1]);
    if (parsed) references.add(formatAddress(parsed.prefix, parsed.localId, parsed.fragment));
  }
  return [...references];
}

function log(agentLog: AgentLog, event: string, details: Record<string, unknown>): void {
  void agentLog.write(event, details).catch((error) => console.error("Could not write Scribe agent log", error));
}

interface LiveScribeActivity {
  callId: string | null;
  label: string;
  updatedAt: string;
}

interface ActiveScribeRun {
  projectId: number;
  userId: number;
  controller: AbortController;
}

interface ScribeProject extends ProjectSandboxIdentity {
  scribeProvider: string | null;
  scribeModel: string | null;
  scribeThinkingLevel: ScribeSelection["thinkingLevel"];
}

function clipped(value: unknown, length = 100): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const clean = value.trim().replace(/\s+/g, " ");
  return clean.length <= length ? clean : `${clean.slice(0, length - 1)}…`;
}

function quoted(value: unknown): string | null {
  const text = clipped(value, 80);
  return text ? `“${text}”` : null;
}

/** Produces the bounded user-facing summary of one observable Scribe tool call. */
export function describeScribeToolActivity(activity: ScribeToolActivity): string {
  const input = activity.input ?? {};
  switch (activity.toolName) {
    case "read_address": {
      const address = clipped(input.address);
      return address ? `Reading [[${address}]]…` : "Reading a forum record…";
    }
    case "search_forum":
      return `Searching the forum${quoted(input.query) ? ` for ${quoted(input.query)}` : ""}…`;
    case "web_search":
      return `Searching the web${quoted(input.query) ? ` for ${quoted(input.query)}` : ""}…`;
    case "read_web": {
      const url = clipped(input.url, 120);
      return url ? `Reading ${url}…` : "Reading a web source…";
    }
    case "save_source":
      return `Saving a source${quoted(input.title) ? ` as ${quoted(input.title)}` : ""}…`;
    case "read_source": {
      const address = clipped(input.address);
      return address ? `Reading [[${address}]]…` : "Reading a source…";
    }
    case "list_workspace": {
      const target = clipped(input.path);
      return target ? `Listing ${target}…` : "Listing the workspace…";
    }
    case "read_workspace_file": {
      const target = clipped(input.path);
      return target ? `Reading ${target}…` : "Reading a workspace file…";
    }
    case "write_workspace_file": {
      const target = clipped(input.path);
      return target ? `Writing ${target}…` : "Writing a workspace file…";
    }
    case "run_workspace_command": {
      const argv = Array.isArray(input.argv) ? input.argv.filter((part): part is string => typeof part === "string") : [];
      const shell = argv[0] === "sh" || argv[0] === "bash" || argv[0] === "zsh";
      const command = shell ? null : clipped(argv.slice(0, 4).join(" "), 100);
      return command ? `Running ${command}…` : "Running a workspace command…";
    }
    default:
      return `Using ${activity.toolName.replaceAll("_", " ")}…`;
  }
}

/** Scribe calls run only in this process, so none can remain active across a restart. */
export async function reconcileScribeConversations(database: AppDatabase): Promise<number> {
  const result = await database.pool.query(
    "update conversation set status = 'idle', updated_at = now() where status = 'running'",
  );
  return result.rowCount ?? 0;
}

export function createChatRoutes(database: AppDatabase, agentLog: AgentLog, serviceAccess?: ServiceAccess) {
  const routes = new Hono();
  const activities = new Map<number, LiveScribeActivity>();
  const activeRuns = new Map<number, ActiveScribeRun>();

  routes.get("/projects/:projectId/conversations", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "project_not_found" }, 404);
    }
    const result = await database.pool.query(
      `select c.row_id as id, c.anchor, c.status, c.created_at as "createdAt", c.updated_at as "updatedAt",
              count(m.row_id)::int as "messageCount",
              (select left(first_message.body, 160) from message first_message
                where first_message.conversation_id = c.row_id and first_message.role = 'user'
                order by first_message.row_id limit 1) as preview
         from conversation c left join message m on m.conversation_id = c.row_id
        where c.project_id = $1 and c.user_id = $2
        group by c.row_id
        order by c.updated_at desc`,
      [projectId, actor.id],
    );
    return context.json({
      conversations: result.rows.map((conversation) => {
        const activity = activities.get(Number(conversation.id));
        return {
          ...conversation,
          activity: activity ? { label: activity.label, updatedAt: activity.updatedAt } : null,
        };
      }),
    });
  });

  routes.post("/projects/:projectId/conversations", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "project_not_found" }, 404);
    }
    const input = createConversationInput.safeParse(await context.req.json().catch(() => ({})));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    const anchor = input.data.anchor || null;
    if (anchor) {
      const client = await database.pool.connect();
      try {
        if (!await addressExists(client, projectId, anchor)) return context.json({ error: "anchor_not_found" }, 400);
      } finally {
        client.release();
      }
    }
    const inserted = await database.pool.query(
      `insert into conversation (project_id, user_id, anchor)
       values ($1, $2, $3)
       returning row_id as id, anchor, status, created_at as "createdAt", updated_at as "updatedAt"`,
      [projectId, actor.id, anchor],
    );
    return context.json({ conversation: { ...inserted.rows[0], messageCount: 0, preview: null, activity: null } }, 201);
  });

  routes.get("/projects/:projectId/conversations/:conversationId/messages", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    const conversationId = positiveId(context.req.param("conversationId"));
    if (!projectId || !conversationId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "conversation_not_found" }, 404);
    }
    const conversation = await database.pool.query(
      `select row_id as id, anchor, status, created_at as "createdAt", updated_at as "updatedAt"
         from conversation where row_id = $1 and project_id = $2 and user_id = $3`,
      [conversationId, projectId, actor.id],
    );
    if (!conversation.rows[0]) return context.json({ error: "conversation_not_found" }, 404);
    const messages = await database.pool.query(
      `select row_id as id, role, body, refs, created_at as "createdAt"
         from message where conversation_id = $1 and project_id = $2 order by row_id`,
      [conversationId, projectId],
    );
    return context.json({ conversation: conversation.rows[0], messages: messages.rows });
  });

  routes.post("/projects/:projectId/conversations/:conversationId/stop", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    const conversationId = positiveId(context.req.param("conversationId"));
    if (!projectId || !conversationId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "conversation_not_found" }, 404);
    }
    const conversation = await database.pool.query(
      "select status from conversation where row_id = $1 and project_id = $2 and user_id = $3",
      [conversationId, projectId, actor.id],
    );
    if (!conversation.rows[0]) return context.json({ error: "conversation_not_found" }, 404);
    const active = activeRuns.get(conversationId);
    if (active?.projectId === projectId && active.userId === actor.id) {
      active.controller.abort();
      return context.json({ stopping: true });
    }
    return context.json({ stopping: false });
  });

  routes.post("/projects/:projectId/conversations/:conversationId/replies", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    const conversationId = positiveId(context.req.param("conversationId"));
    if (!projectId || !conversationId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "conversation_not_found" }, 404);
    }
    const input = replyInput.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    const project = await database.pool.query<ScribeProject>(
      `select p.row_id as "projectId", p.public_id as "publicId",
              coalesce(p.scribe_provider, fallback.config ->> 'provider') as "scribeProvider",
              coalesce(p.scribe_model, fallback.config ->> 'model') as "scribeModel",
              case when p.scribe_provider is null
                then coalesce(fallback.config ->> 'thinkingLevel', 'off')
                else p.scribe_thinking_level end as "scribeThinkingLevel"
         from project p
         left join lateral (
           select u.agent_config as config
             from project_member m join forum_user u on u.row_id = m.user_id
            where m.project_id = p.row_id
              and u.kind = 'agent' and u.disabled_at is null and u.agent_config is not null
            order by (lower(u.handle) = 'scribe') desc, u.row_id limit 1
         ) fallback on true
        where p.row_id = $1`,
      [projectId],
    );
    const workspaceProject = project.rows[0];
    if (!workspaceProject) return context.json({ error: "conversation_not_found" }, 404);
    let selection: ScribeSelection;
    if (actor.isOwner) selection = input.data;
    else {
      if (!workspaceProject.scribeProvider || !workspaceProject.scribeModel) {
        return context.json({ error: "scribe_model_not_configured" }, 409);
      }
      selection = {
        provider: workspaceProject.scribeProvider,
        model: workspaceProject.scribeModel,
        thinkingLevel: workspaceProject.scribeThinkingLevel,
      };
    }

    const client = await database.pool.connect();
    try {
      await client.query("begin");
      const claimed = await client.query(
        `update conversation set status = 'running', updated_at = now()
          where row_id = $1 and project_id = $2 and user_id = $3
            and status = 'idle'
        returning row_id`,
        [conversationId, projectId, actor.id],
      );
      if (!claimed.rows[0]) {
        const exists = await client.query(
          "select status from conversation where row_id = $1 and project_id = $2 and user_id = $3",
          [conversationId, projectId, actor.id],
        );
        await client.query("rollback");
        return exists.rows[0]
          ? context.json({ error: "conversation_busy" }, 409)
          : context.json({ error: "conversation_not_found" }, 404);
      }
      await client.query(
        `insert into message (project_id, conversation_id, author_user_id, role, body, refs)
         values ($1, $2, $3, 'user', $4, $5)`,
        [projectId, conversationId, actor.id, input.data.body, messageReferences(input.data.body)],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const replyController = new AbortController();
    activeRuns.set(conversationId, { projectId, userId: actor.id, controller: replyController });
    activities.set(conversationId, {
      callId: null,
      label: "Thinking through the request…",
      updatedAt: new Date().toISOString(),
    });
    try {
      const historyResult = await database.pool.query<ScribeHistoryMessage>(
        `select role, body from (
           select row_id, role, body from message
            where conversation_id = $1 and project_id = $2
            order by row_id desc limit $3
         ) recent order by row_id`,
        [conversationId, projectId, SCRIBE_HISTORY_MESSAGE_LIMIT],
      );
      const reply = await runScribe(
        database,
        agentLog,
        conversationId,
        projectId,
        actor.id,
        historyResult.rows,
        selection,
        workspaceProject,
        actor.isOwner,
        serviceAccess,
        (activity) => {
          const current = activities.get(conversationId);
          if (activity.phase === "start") {
            activities.set(conversationId, {
              callId: activity.callId,
              label: describeScribeToolActivity(activity),
              updatedAt: new Date().toISOString(),
            });
          } else if (current?.callId === activity.callId) {
            activities.set(conversationId, {
              callId: null,
              label: "Reviewing the result…",
              updatedAt: new Date().toISOString(),
            });
          }
        },
        replyController.signal,
      );
      if (replyController.signal.aborted) throw new Error("scribe_stopped");
      const completion = await database.pool.connect();
      try {
        await completion.query("begin");
        const completed = await completion.query(
          `update conversation set status = 'idle', updated_at = now()
            where row_id = $1 and project_id = $2 and user_id = $3 and status = 'running'
          returning row_id`,
          [conversationId, projectId, actor.id],
        );
        if (!completed.rows[0]) throw new Error("conversation_completion_failed");
        if (replyController.signal.aborted) throw new Error("scribe_stopped");
        const inserted = await completion.query(
          `insert into message (project_id, conversation_id, role, body, refs)
           values ($1, $2, 'assistant', $3, $4)
           returning row_id as id, role, body, refs, created_at as "createdAt"`,
          [projectId, conversationId, reply, messageReferences(reply)],
        );
        await completion.query("commit");
        return context.json({ message: inserted.rows[0] }, 201);
      } catch (error) {
        await completion.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        completion.release();
      }
    } catch (error) {
      await database.pool.query(
        "update conversation set status = 'idle', updated_at = now() where row_id = $1 and project_id = $2 and user_id = $3",
        [conversationId, projectId, actor.id],
      ).catch(() => undefined);
      if (replyController.signal.aborted) {
        log(agentLog, "scribe.stopped", { conversationId });
        return context.json({ stopped: true });
      }
      log(agentLog, "scribe.failed", {
        conversationId,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      });
      const message = error instanceof Error ? error.message : "scribe_failed";
      const status = message.startsWith("model_not_found:") ? 422 : 502;
      return context.json({ error: message }, status);
    } finally {
      activities.delete(conversationId);
      if (activeRuns.get(conversationId)?.controller === replyController) activeRuns.delete(conversationId);
    }
  });

  return routes;
}
