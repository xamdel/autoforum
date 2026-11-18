import { Hono } from "hono";
import { z } from "zod";

import { hasExactBrowserOrigin, readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";
import { isProjectMember } from "../projects.ts";

const createSubforumInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(""),
}).strict();

function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function listProjectSubforums(database: AppDatabase, projectId: number) {
  const result = await database.pool.query(
    `select s.row_id as id, s.name, s.description, s.created_at as "createdAt",
            count(t.row_id)::int as "threadCount"
       from subforum s
       left join thread t on t.subforum_id = s.row_id
      where s.project_id = $1
      group by s.row_id
      order by s.created_at, s.row_id`,
    [projectId],
  );
  return result.rows;
}

export function createSubforumRoutes(database: AppDatabase) {
  const routes = new Hono();

  routes.get("/projects/:projectId/subforums", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "project_not_found" }, 404);
    }
    return context.json({ subforums: await listProjectSubforums(database, projectId) });
  });

  routes.post("/projects/:projectId/subforums", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);
    if (!actor.isOwner) return context.json({ error: "owner_required" }, 403);
    const projectId = positiveId(context.req.param("projectId"));
    if (!projectId || !await isProjectMember(database, actor.id, projectId)) {
      return context.json({ error: "project_not_found" }, 404);
    }
    const input = createSubforumInput.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_input" }, 400);
    try {
      const result = await database.pool.query(
        `insert into subforum (project_id, name, description)
         values ($1, $2, $3)
         returning row_id as id, name, description, created_at as "createdAt"`,
        [projectId, input.data.name, input.data.description],
      );
      return context.json({ subforum: { ...result.rows[0], threadCount: 0 } }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) return context.json({ error: "subforum_name_conflict" }, 409);
      throw error;
    }
  });

  return routes;
}
