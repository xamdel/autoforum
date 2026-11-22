import { Hono } from "hono";
import { z } from "zod";

import { readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";
import { piModelRuntime } from "./pi.ts";

const providerIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export interface ModelCatalogEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
}

/** The small, non-secret part of Pi's catalog that model pickers need. */
export function listCatalogModels(
  models: Pick<Awaited<ReturnType<typeof piModelRuntime>>, "getProvider" | "getModels">,
  providerId: string,
): ModelCatalogEntry[] | null {
  if (providerId === "claude-code") {
    return ["haiku", "opus", "sonnet"].map((id) => ({
      id,
      name: id[0]!.toUpperCase() + id.slice(1),
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 0,
    }));
  }
  if (!models.getProvider(providerId)) return null;

  return [...new Map(models.getModels(providerId).map((model) => [model.id, {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
  }])).values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function createModelCatalogRoutes(database: AppDatabase) {
  const routes = new Hono();

  routes.get("/:provider", async (context) => {
    const actor = await readBrowserUser(context, database);
    if (!actor) return context.json({ error: "unauthenticated" }, 401);

    const provider = providerIdSchema.safeParse(context.req.param("provider"));
    if (!provider.success) return context.json({ error: "invalid_input" }, 400);
    const models = listCatalogModels(await piModelRuntime(), provider.data);
    return models ? context.json({ models }) : context.json({ error: "model_provider_not_found" }, 404);
  });

  return routes;
}
