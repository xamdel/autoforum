import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { createAgentProfileRoutes } from "./agents/profiles.ts";
import { createAgentTurnRoutes, type AgentRunnerControl, type EnqueueAgentTurns } from "./agents/turns.ts";
import { createBrowserAuthRoutes } from "./auth/browser.ts";
import { createMcpCredentialRoutes } from "./auth/mcp-credentials.ts";
import { createProjectInviteRoutes } from "./auth/project-invites.ts";
import { createChatRoutes } from "./chat.ts";
import type { AppDatabase } from "./db.ts";
import type { AgentLog } from "./logging/agents.ts";
import type { SystemLog } from "./logging/system.ts";
import { createPublishRoutes } from "./forum/publish.ts";
import { createForumQueryRoutes } from "./forum/queries.ts";
import { createSubforumRoutes } from "./forum/subforums.ts";
import { createThreadRoutes } from "./forum/threads.ts";
import { createMcpRoutes } from "./mcp.ts";
import { createChatgptRoutes } from "./model-adapters/chatgpt.ts";
import { createClaudeCodeRoutes } from "./model-adapters/claude-code.ts";
import { createModelCatalogRoutes } from "./model-adapters/catalog.ts";
import { createModelApiKeyRoutes } from "./model-adapters/pi.ts";
import { createServiceAccessRoutes } from "./service-access/routes.ts";
import type { ServiceAccess } from "./service-access/services.ts";
import { createPreviewFeature, previewFrameSource } from "./workspace/preview.ts";
import { createProjectRoutes } from "./projects.ts";
import {
  createSandboxLifecycleRoutes,
  getProjectPreviewTarget,
  synchronizeProjectSidecar,
  workspaceShellIsAvailable,
  type ProjectSandboxIdentity,
  type SandboxServiceAccess,
} from "./sandbox/lifecycle.ts";
import { createSourceLibraryRoutes } from "./sources/library.ts";
import { createSourceReaderRoutes } from "./sources/reader.ts";
import { createUserRoutes } from "./users.ts";
import { createWorkspaceRoutes } from "./workspace/files.ts";

export interface AppDependencies {
  checkDatabase(): Promise<void>;
  isQueueRunning(): boolean;
  database?: AppDatabase;
  agentLog?: AgentLog;
  agentRunner?: AgentRunnerControl;
  enqueueAgentTurns?: EnqueueAgentTurns;
  serviceAccess?: ServiceAccess;
  serviceAccessSidecar?: (project: ProjectSandboxIdentity) => SandboxServiceAccess;
  systemLog?: SystemLog;
  port?: number;
  webRoot?: string;
}

export function createApp(dependencies: AppDependencies) {
  const app = new Hono();
  const preview = dependencies.database ? createPreviewFeature(
    dependencies.database,
    async (project) => {
      const target = await getProjectPreviewTarget(project);
      if (!await workspaceShellIsAvailable(target)) throw new Error("sandbox_preview_unavailable");
      return target;
    },
  ) : undefined;

  if (dependencies.systemLog) {
    app.use("*", async (context, next) => {
      const startedAt = performance.now();
      await next();
      const failedOperation = context.res.status !== 500
        && context.req.path !== "/health"
        && (context.res.status >= 500 || (context.req.method !== "GET" && context.res.status >= 409));
      if (failedOperation) {
        const responseBody = await context.res.clone().json().catch(() => null) as { error?: unknown } | null;
        dependencies.systemLog!.warn("http.failure", {
          method: context.req.method,
          path: context.req.path,
          status: context.res.status,
          durationMs: Math.round(performance.now() - startedAt),
          ...(typeof responseBody?.error === "string" ? { reason: responseBody.error } : {}),
        });
      }
    });
  }

  if (preview) app.use("*", preview.middleware);

  if (dependencies.webRoot) {
    app.use("*", async (context, next) => {
      await next();
      context.header("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src ${previewFrameSource()}; frame-ancestors 'self'; form-action 'self'`);
      context.header("X-Content-Type-Options", "nosniff");
      context.header("Referrer-Policy", "same-origin");
    });
  }

  app.get("/health", async (context) => {
    if (!dependencies.isQueueRunning()) {
      return context.json({ status: "unavailable", database: "unknown", worker: "unavailable" }, 503);
    }

    try {
      await dependencies.checkDatabase();
      return context.json({ status: "ok", database: "ok", worker: "ok" });
    } catch {
      return context.json({ status: "unavailable", database: "unavailable", worker: "ok" }, 503);
    }
  });

  if (dependencies.database) {
    app.route("/api/auth", createBrowserAuthRoutes(dependencies.database));
    app.route("/api", createProjectInviteRoutes(dependencies.database));
    app.route("/api/users", createUserRoutes(dependencies.database));
    app.route("/api/projects", createProjectRoutes(dependencies.database, dependencies.enqueueAgentTurns));
    app.route("/api", createMcpCredentialRoutes(dependencies.database));
    app.route("/api", createSubforumRoutes(dependencies.database));
    app.route("/api", createThreadRoutes(dependencies.database, dependencies.enqueueAgentTurns));
    app.route("/api", createPublishRoutes(dependencies.database, dependencies.enqueueAgentTurns));
    app.route("/api", createForumQueryRoutes(dependencies.database));
    app.route("/api", createSourceLibraryRoutes(dependencies.database));
    app.route("/api", createSourceReaderRoutes(dependencies.database));
    app.route("/api", createSandboxLifecycleRoutes(dependencies.database, {
      serviceAccess: dependencies.serviceAccessSidecar,
      onStopped: dependencies.serviceAccess ? (project) => dependencies.serviceAccess!.revokeProject(project.publicId) : undefined,
    }));
    app.route("/api", createWorkspaceRoutes(dependencies.database));
    if (dependencies.serviceAccess) app.route("/api", createServiceAccessRoutes(
      dependencies.database,
      dependencies.serviceAccess,
      dependencies.serviceAccessSidecar
        ? (project) => synchronizeProjectSidecar(project, dependencies.serviceAccessSidecar!(project))
        : undefined,
    ));
    app.route("/api", preview!.routes);
    app.route("/api", createAgentProfileRoutes(dependencies.database));
    app.route("/api", createAgentTurnRoutes(dependencies.database, dependencies.enqueueAgentTurns, dependencies.agentRunner));
    app.route("/api/model-access/chatgpt", createChatgptRoutes(dependencies.database, dependencies.port ?? 3_000));
    app.route("/api/model-access/claude-code", createClaudeCodeRoutes(dependencies.database));
    app.route("/api/model-access/models", createModelCatalogRoutes(dependencies.database));
    app.route("/api/model-access/api-keys", createModelApiKeyRoutes(dependencies.database));
    if (dependencies.agentLog) app.route("/api", createChatRoutes(dependencies.database, dependencies.agentLog, dependencies.serviceAccess));
    app.route("/mcp", createMcpRoutes(dependencies.database, dependencies.enqueueAgentTurns));
  }

  if (dependencies.webRoot) {
    app.use("/assets/*", serveStatic({ root: dependencies.webRoot }));
    app.get("/", serveStatic({ root: dependencies.webRoot, path: "index.html" }));
  }

  app.notFound((context) => context.json({ error: "not_found" }, 404));
  app.onError((error, context) => {
    if (dependencies.systemLog) {
      dependencies.systemLog.error("http.unhandled_error", error, {
        method: context.req.method,
        path: context.req.path,
      });
    } else console.error(error);
    return context.json({ error: "internal_error" }, 500);
  });
  return app;
}
