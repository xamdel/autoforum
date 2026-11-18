import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export interface AgentLog {
  write(event: string, details: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

function fileName(date: Date): string {
  return `agent-${date.toISOString().slice(0, 10)}.jsonl`;
}

async function removeExpiredFiles(directory: string, now = Date.now()): Promise<void> {
  const names = await readdir(directory).catch(() => []);
  await Promise.all(names
    .filter((name) => /^agent-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .map(async (name) => {
      const target = path.join(directory, name);
      const info = await stat(target).catch(() => null);
      if (info && now - info.mtimeMs > RETENTION_MS) await unlink(target).catch(() => undefined);
    }));
}

/** Daily JSONL model and tool traffic for debugging agent turns; never durable application state. */
export async function startAgentLog(directory = path.resolve(".autoforum", "logs")): Promise<AgentLog> {
  await mkdir(directory, { recursive: true });
  await removeExpiredFiles(directory);
  const cleanup = setInterval(() => void removeExpiredFiles(directory), 24 * 60 * 60 * 1_000);
  cleanup.unref();
  let pending = Promise.resolve();

  return {
    write(event, details) {
      const at = new Date();
      const line = `${JSON.stringify({ at: at.toISOString(), event, ...details })}\n`;
      pending = pending.then(() => appendFile(path.join(directory, fileName(at)), line, "utf8"));
      return pending;
    },
    async close() {
      clearInterval(cleanup);
      await pending;
    },
  };
}
