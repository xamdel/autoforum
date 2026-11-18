import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|session|token|api[-_]?key)/i;
const SENSITIVE_TEXT: Array<[RegExp, string]> = [
  [/\bBearer\s+[^\s,;]+/gi, "[REDACTED]"],
  [/\b(?:api[-_]?key|authorization|cookie|password|secret|session|token)\s*[=:]\s*[^\s,;&]+/gi, "[REDACTED]"],
  [/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[REDACTED]@"],
  [/\bsk-(?:ant-)?[a-z0-9_-]{12,}/gi, "[REDACTED]"],
];

export type SystemLogLevel = "info" | "warn" | "error";

export interface SystemLog {
  info(event: string, details?: Record<string, unknown>): void;
  warn(event: string, details?: Record<string, unknown>): void;
  error(event: string, error: unknown, details?: Record<string, unknown>): void;
  close(): Promise<void>;
}

function fileName(date: Date): string {
  return `system-${date.toISOString().slice(0, 10)}.jsonl`;
}

function scrubText(value: string): string {
  return SENSITIVE_TEXT.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function safeValue(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    const code = "code" in value && ["string", "number"].includes(typeof value.code) ? value.code : undefined;
    return {
      name: value.name,
      message: scrubText(value.message),
      ...(value.stack ? { stack: scrubText(value.stack) } : {}),
      ...(code === undefined ? {} : { code }),
    };
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => safeValue(item, "", seen));
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, safeValue(item, name, seen)]));
}

async function removeExpiredFiles(directory: string, now = Date.now()): Promise<void> {
  const names = await readdir(directory).catch(() => []);
  await Promise.all(names
    .filter((name) => /^system-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .map(async (name) => {
      const target = path.join(directory, name);
      const info = await stat(target).catch(() => null);
      if (info && now - info.mtimeMs > RETENTION_MS) await unlink(target).catch(() => undefined);
    }));
}

/** Short-lived operational logs for troubleshooting an installation; never durable application state. */
export async function startSystemLog(
  directory = path.resolve(".autoforum", "logs"),
  options: { mirror?: boolean } = {},
): Promise<SystemLog> {
  await mkdir(directory, { recursive: true });
  await removeExpiredFiles(directory);
  const cleanup = setInterval(() => void removeExpiredFiles(directory), 24 * 60 * 60 * 1_000);
  cleanup.unref();
  let pending = Promise.resolve();
  const mirror = options.mirror ?? true;

  const record = (
    level: SystemLogLevel,
    event: string,
    details: Record<string, unknown> = {},
    error?: unknown,
  ) => {
    if (mirror) {
      const output = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      if (error === undefined) output(`[${event}]`, details);
      else output(`[${event}]`, error, details);
    }
    const at = new Date();
    const safeDetails = safeValue(details) as Record<string, unknown>;
    const line = `${JSON.stringify({
      at: at.toISOString(),
      level,
      event,
      ...safeDetails,
      ...(error === undefined ? {} : { error: safeValue(error) }),
    })}\n`;
    pending = pending
      .then(() => appendFile(path.join(directory, fileName(at)), line, "utf8"))
      .catch((writeError) => {
        console.error("Could not write Autoforum system log", writeError);
      });
  };

  return {
    info(event, details) { record("info", event, details); },
    warn(event, details) { record("warn", event, details); },
    error(event, error, details) { record("error", event, details, error); },
    async close() {
      clearInterval(cleanup);
      await pending;
    },
  };
}
