import type { PoolClient } from "pg";
import { z } from "zod";

import type { AppDatabase } from "../db.ts";
import type { SystemLog } from "../logging/system.ts";
import { formatAddress, parseAddress, reserveProjectAddresses } from "./addresses.ts";
import { collectWorkspaceFiles, listWorkspaceDirectory, type WorkspaceEntry } from "../sandbox/filesystem.ts";
import type { ProjectSandboxIdentity } from "../sandbox/lifecycle.ts";

export const RESULT_OUTBOX = ".autoforum/results";
const MAX_RESULTS_PER_SCAN = 50;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const RESULT_SCAN_INTERVAL_MS = 10_000;

const submissionFilePattern = /^([a-z0-9][a-z0-9_-]{0,63})\.json$/;
const outputKeyPattern = /^[a-z][a-z0-9_-]{0,63}$/;

export const resultEnvelopeSchema = z.object({
  target: z.string().regex(/^(?:thread|proposal):[1-9]\d*$/),
  outputs: z.record(z.string().regex(outputKeyPattern), z.unknown()),
}).strict().superRefine((value, context) => {
  const count = Object.keys(value.outputs).length;
  if (count < 1) context.addIssue({ code: "custom", path: ["outputs"], message: "outputs must not be empty" });
  if (count > 64) context.addIssue({ code: "custom", path: ["outputs"], message: "outputs has at most 64 keys" });
});

/** Gives malformed producers a protocol-level error instead of Zod's generic record diagnostic. */
export function parseResultEnvelope(value: unknown): z.infer<typeof resultEnvelopeSchema> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const outputs = (value as Record<string, unknown>).outputs;
    if (Array.isArray(outputs)) {
      throw new Error("invalid_result_outputs: outputs must be a JSON object with named, addressable keys; arrays are valid only as values under those keys");
    }
  }
  return resultEnvelopeSchema.parse(value);
}

export interface ResultImportReport {
  imported: Array<{ submissionId: string; address: string }>;
  rejected: Array<{ path: string; error: string }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outboxUnavailable(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("sandbox_not_created")
    || message.includes("sandbox_not_running")
    || message.includes("ENOENT");
}

async function resolveTarget(client: PoolClient, projectId: number, target: string) {
  const parsed = parseAddress(target);
  if (!parsed || parsed.fragment || (parsed.prefix !== "thread" && parsed.prefix !== "proposal")) {
    throw new Error("invalid_result_target");
  }
  if (parsed.prefix === "thread") {
    const found = await client.query<{ threadId: number }>(
      `select row_id as "threadId" from thread where project_id = $1 and local_id = $2`,
      [projectId, parsed.localId],
    );
    if (!found.rows[0]) throw new Error("result_target_not_found");
    return { threadId: found.rows[0].threadId, proposalId: null };
  }
  const found = await client.query<{ proposalId: number; threadId: number }>(
      `select d.row_id as "proposalId", p.thread_id as "threadId"
       from discourse_object d join post p on p.row_id = d.born_in_post_id
      where d.project_id = $1 and p.project_id = $1 and d.local_id = $2 and d.kind = 'proposal'`,
    [projectId, parsed.localId],
  );
  if (!found.rows[0]) throw new Error("result_target_not_found");
  return found.rows[0];
}

export async function storeResultEnvelope(
  database: AppDatabase,
  projectId: number,
  submissionId: string,
  envelope: z.infer<typeof resultEnvelopeSchema>,
): Promise<string | null> {
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ localId: number }>(
      `select local_id as "localId" from result where project_id = $1 and submission_id = $2`,
      [projectId, submissionId],
    );
    if (existing.rows[0]) {
      await client.query("rollback");
      return null;
    }
    const target = await resolveTarget(client, projectId, envelope.target);
    const localId = await reserveProjectAddresses(client, projectId, 1);
    await client.query(
      `insert into result (project_id, local_id, submission_id, thread_id, proposal_id, outputs)
       values ($1, $2, $3, $4, $5, $6)`,
      [projectId, localId, submissionId, target.threadId, target.proposalId, envelope.outputs],
    );
    await client.query("commit");
    return formatAddress("result", localId);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") return null;
    throw error;
  } finally {
    client.release();
  }
}

/** Imports complete JSON envelopes from the project sandbox's fixed filesystem outbox. */
export async function importProjectResults(
  database: AppDatabase,
  project: ProjectSandboxIdentity,
): Promise<ResultImportReport> {
  let entries: WorkspaceEntry[];
  try {
    entries = await listWorkspaceDirectory(project, RESULT_OUTBOX);
  } catch (error) {
    if (outboxUnavailable(error)) return { imported: [], rejected: [] };
    throw error;
  }

  const candidates = entries.flatMap((entry) => {
    const match = entry.kind === "regular" ? submissionFilePattern.exec(entry.name) : null;
    return match ? [{ entry, submissionId: match[1]! }] : [];
  });
  if (!candidates.length) return { imported: [], rejected: [] };

  const existing = await database.pool.query<{ submissionId: string }>(
    `select submission_id as "submissionId" from result
      where project_id = $1 and submission_id = any($2::text[])`,
    [project.projectId, candidates.map((candidate) => candidate.submissionId)],
  );
  const seen = new Set(existing.rows.map((row) => row.submissionId));
  const pending = candidates.filter((candidate) => !seen.has(candidate.submissionId));
  const rejected: ResultImportReport["rejected"] = pending
    .filter((candidate) => candidate.entry.size === null || candidate.entry.size > MAX_RESULT_BYTES)
    .map((candidate) => ({ path: candidate.entry.path, error: "result_file_too_large" }));
  const readable: typeof pending = [];
  let scanBytes = 0;
  for (const candidate of pending) {
    if (candidate.entry.size === null || candidate.entry.size > MAX_RESULT_BYTES) continue;
    if (readable.length >= MAX_RESULTS_PER_SCAN || scanBytes + candidate.entry.size > MAX_SCAN_BYTES) break;
    readable.push(candidate);
    scanBytes += candidate.entry.size;
  }
  if (!readable.length) return { imported: [], rejected };

  const collection = await collectWorkspaceFiles(
    project,
    readable.map((candidate) => candidate.entry.path),
    { maxFileBytes: MAX_RESULT_BYTES, maxTotalBytes: MAX_SCAN_BYTES },
  );
  const byPath = new Map(readable.map((candidate) => [candidate.entry.path, candidate.submissionId]));
  const imported: ResultImportReport["imported"] = [];
  for (const file of collection.files) {
    const submissionId = byPath.get(file.path)!;
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      const envelope = parseResultEnvelope(JSON.parse(decoded));
      const address = await storeResultEnvelope(database, project.projectId, submissionId, envelope);
      if (address) imported.push({ submissionId, address });
    } catch (error) {
      rejected.push({ path: file.path, error: errorMessage(error) });
    }
  }
  return { imported, rejected };
}

export async function listThreadResults(database: AppDatabase, projectId: number, threadId: number) {
  const found = await database.pool.query<{
    id: number;
    localId: number;
    submissionId: string;
    outputs: Record<string, unknown>;
    proposalLocalId: number | null;
    expectedOutputs: Record<string, unknown> | null;
    createdAt: Date;
  }>(
    `select r.row_id as id, r.local_id as "localId", r.submission_id as "submissionId", r.outputs,
            d.local_id as "proposalLocalId", d.expected_outputs as "expectedOutputs", r.created_at as "createdAt"
       from result r left join discourse_object d on d.row_id = r.proposal_id
      where r.project_id = $1 and r.thread_id = $2
      order by r.local_id`,
    [projectId, threadId],
  );
  return found.rows.map((row) => {
    const outputKeys = Object.keys(row.outputs);
    const expectedKeys = Object.keys(row.expectedOutputs ?? {});
    return {
      ...row,
      address: formatAddress("result", row.localId),
      proposalAddress: row.proposalLocalId ? formatAddress("proposal", row.proposalLocalId) : null,
      missingOutputs: expectedKeys.filter((key) => !outputKeys.includes(key)),
      additionalOutputs: expectedKeys.length ? outputKeys.filter((key) => !expectedKeys.includes(key)) : [],
    };
  });
}

export function startResultImporter(
  database: AppDatabase,
  systemLog?: SystemLog,
  intervalMs = RESULT_SCAN_INTERVAL_MS,
) {
  let stopped = false;
  let active: Promise<void> = Promise.resolve();
  const reported = new Set<string>();

  const scan = async () => {
    const projects = await database.pool.query<ProjectSandboxIdentity>(
      `select row_id as "projectId", public_id as "publicId" from project order by row_id`,
    );
    for (const project of projects.rows) {
      try {
        const report = await importProjectResults(database, project);
        for (const item of report.imported) {
          if (systemLog) systemLog.info("result.imported", { projectId: project.projectId, address: item.address, submissionId: item.submissionId });
          else console.log(`Imported ${item.address} from ${RESULT_OUTBOX}/${item.submissionId}.json`);
        }
        for (const item of report.rejected) {
          const key = `${project.projectId}:${item.path}:${item.error}`;
          if (!reported.has(key)) {
            if (systemLog) systemLog.warn("result.rejected", { projectId: project.projectId, path: item.path, reason: item.error });
            else console.warn(`Rejected result file ${item.path}: ${item.error}`);
          }
          reported.add(key);
        }
      } catch (error) {
        const message = errorMessage(error);
        const key = `${project.projectId}:scan:${message}`;
        if (!reported.has(key)) {
          if (systemLog) systemLog.error("result.scan_failed", error, { projectId: project.projectId });
          else console.warn(`Could not scan result outbox for project ${project.projectId}: ${message}`);
        }
        reported.add(key);
      }
    }
  };
  let busy = false;
  const tick = () => {
    if (stopped || busy) return;
    busy = true;
    active = scan().catch((error) => {
      if (systemLog) systemLog.error("result.importer_failed", error);
      else console.error("Result importer failed", error);
    }).finally(() => { busy = false; });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
