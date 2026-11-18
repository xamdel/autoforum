import path from "node:path";

import { Hono, type Context } from "hono";

import { readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";
import { listWorkspaceTree, readWorkspaceFile, workspaceUsage } from "../sandbox/filesystem.ts";
import type { ProjectSandboxIdentity } from "../sandbox/lifecycle.ts";

async function authorizedProject(
  context: Context,
  database: AppDatabase,
): Promise<ProjectSandboxIdentity | "unauthenticated" | "owner_required" | "project_not_found"> {
  const actor = await readBrowserUser(context, database);
  if (!actor) return "unauthenticated";
  if (!actor.isOwner) return "owner_required";
  const projectId = Number(context.req.param("projectId"));
  if (!Number.isSafeInteger(projectId) || projectId < 1) return "project_not_found";
  const result = await database.pool.query<ProjectSandboxIdentity>(
    `select p.row_id as "projectId", p.public_id as "publicId"
       from project p join project_member m on m.project_id = p.row_id
      where p.row_id = $1 and m.user_id = $2`,
    [projectId, actor.id],
  );
  return result.rows[0] ?? "project_not_found";
}

function authorizationResponse(context: Context, result: string) {
  return result === "unauthenticated"
    ? context.json({ error: result }, 401)
    : result === "owner_required"
      ? context.json({ error: result }, 403)
      : context.json({ error: result }, 404);
}

function workspaceFailure(context: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("not_running") || message.includes("not_created") ? 409 : message.includes("invalid_path") ? 400 : 422;
  return context.json({ error: message }, status as 400 | 409 | 422);
}

export function createWorkspaceRoutes(database: AppDatabase) {
  const routes = new Hono();

  routes.get("/projects/:projectId/workspace/tree", async (context) => {
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    try {
      return context.json({ entries: await listWorkspaceTree(project) });
    } catch (error) {
      return workspaceFailure(context, error);
    }
  });

  routes.get("/projects/:projectId/workspace/views", async (context) => {
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    try {
      const entries = await listWorkspaceTree(project, "artifacts");
      const views = entries
        .filter((entry) => entry.kind === "regular" && /\.(?:md|markdown|html?)$/i.test(entry.path))
        .map((entry) => ({ ...entry, kind: /\.html?$/i.test(entry.path) ? "html" : "markdown" }));
      return context.json({ views });
    } catch (error) {
      return workspaceFailure(context, error);
    }
  });

  routes.get("/projects/:projectId/workspace/file", async (context) => {
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    const requestedPath = context.req.query("path");
    if (!requestedPath) return context.json({ error: "path_required" }, 400);
    try {
      const file = await readWorkspaceFile(project, requestedPath);
      let text: string | undefined;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); } catch { /* binary */ }
      return context.json({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        ...(text === undefined ? { encoding: "base64", content: file.bytes.toString("base64") } : { encoding: "utf8", content: text }),
      });
    } catch (error) {
      return workspaceFailure(context, error);
    }
  });

  routes.get("/projects/:projectId/workspace/download", async (context) => {
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    const requestedPath = context.req.query("path");
    if (!requestedPath) return context.json({ error: "path_required" }, 400);
    try {
      const file = await readWorkspaceFile(project, requestedPath, 16 * 1024 * 1024);
      const filename = path.posix.basename(file.path);
      return new Response(Uint8Array.from(file.bytes), {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(file.size),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      return workspaceFailure(context, error);
    }
  });

  routes.get("/projects/:projectId/workspace/usage", async (context) => {
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    try { return context.json(await workspaceUsage(project)); }
    catch (error) { return workspaceFailure(context, error); }
  });

  return routes;
}
