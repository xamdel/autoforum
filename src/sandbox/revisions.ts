import { z } from "zod";

import { runSandboxCommand } from "./execution.ts";
import type { ProjectSandboxIdentity } from "./lifecycle.ts";

const revisionResultSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{40,64}$/),
  snapshot: z.boolean(),
}).strict();

/** Captures the non-ignored workspace as a Git commit without changing its branch or index. */
export async function captureWorkspaceRevision(project: ProjectSandboxIdentity) {
  const result = await runSandboxCommand(project, {
    argv: ["node", "/usr/local/bin/autoforum-workspace-revision.mjs"],
    timeoutMs: 60_000,
    maxOutputBytes: 16 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString("utf8").trim() || "workspace_revision_failed");
  }
  try {
    return revisionResultSchema.parse(JSON.parse(result.stdout.toString("utf8")));
  } catch {
    throw new Error("invalid_workspace_revision_response");
  }
}
