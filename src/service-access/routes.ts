import { Hono, type Context } from "hono";
import { z } from "zod";

import { hasExactBrowserOrigin, readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";
import type { ProjectSandboxIdentity } from "../sandbox/lifecycle.ts";
import { ServiceAccess, serviceNameSchema, serviceSchema } from "./services.ts";

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

function featureFailure(context: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("not_running") || message.includes("not_created")
    ? 409
    : message.startsWith("service_access_")
      ? 400
      : 422;
  return context.json({ error: message }, status as 400 | 409 | 422);
}

const configureInput = z.union([
  z.object({
    service: serviceSchema,
    credential: z.string().max(16_384).optional(),
  }).strict(),
  z.object({ modelProvider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/) }).strict(),
]);

export function createServiceAccessRoutes(
  database: AppDatabase,
  access: ServiceAccess,
  synchronizeSidecar?: (project: ProjectSandboxIdentity) => Promise<void>,
) {
  const routes = new Hono();

  routes.get("/projects/:projectId/service-access", async (context) => {
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    return context.json({ services: access.list(project.publicId) });
  });

  routes.put("/projects/:projectId/service-access/:name", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    const input = configureInput.safeParse(await context.req.json().catch(() => null));
    const name = context.req.param("name");
    if (!input.success || !serviceNameSchema.safeParse(name).success) {
      return context.json({ error: "invalid_input" }, 400);
    }
    if ("service" in input.data && input.data.service.name !== name) return context.json({ error: "invalid_input" }, 400);
    if ("modelProvider" in input.data && access.modelService(input.data.modelProvider)?.name !== name) {
      return context.json({ error: "invalid_input" }, 400);
    }
    try {
      const wasGranted = access.hasActiveGrant(project.publicId, name);
      const service = "modelProvider" in input.data
        ? await access.configureModelProvider(project.publicId, input.data.modelProvider)
        : await access.configure(project.publicId, input.data.service, input.data.credential);
      // An inactive service is not present in the sidecar. Saving it needs no container work;
      // editing an active service revoked its grant, so remove that route immediately.
      if (wasGranted) await synchronizeSidecar?.(project);
      return context.json({ service });
    } catch (error) {
      return featureFailure(context, error);
    }
  });

  routes.post("/projects/:projectId/service-access/:name/grant", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    const name = context.req.param("name");
    if (!serviceNameSchema.safeParse(name).success) return context.json({ error: "invalid_input" }, 400);
    try {
      const service = await access.grant(project.publicId, name);
      try {
        await synchronizeSidecar?.(project);
        return context.json({ service });
      } catch (error) {
        access.revokeGrant(project.publicId, name);
        throw error;
      }
    } catch (error) {
      return featureFailure(context, error);
    }
  });

  routes.delete("/projects/:projectId/service-access/:name/grant", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    if (!serviceNameSchema.safeParse(context.req.param("name")).success) return context.json({ error: "invalid_input" }, 400);
    access.revokeGrant(project.publicId, context.req.param("name"));
    try {
      await synchronizeSidecar?.(project);
      return context.json({ ok: true });
    } catch (error) {
      return featureFailure(context, error);
    }
  });

  routes.delete("/projects/:projectId/service-access/:name", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    if (!serviceNameSchema.safeParse(context.req.param("name")).success) return context.json({ error: "invalid_input" }, 400);
    try {
      await access.remove(project.publicId, context.req.param("name"));
      await synchronizeSidecar?.(project);
      return context.json({ ok: true });
    } catch (error) {
      return featureFailure(context, error);
    }
  });

  return routes;
}
