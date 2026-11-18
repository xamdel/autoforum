import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { issueSignInLink } from "../src/auth/browser.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db.ts";
import { ensureInstallationOwner } from "../src/users.ts";

const DEFAULT_WEB_PORT = 5_173;
const TUNNEL_START_TIMEOUT_MS = 45_000;
const APPLICATION_START_TIMEOUT_MS = 120_000;
const children = new Set<ChildProcess>();
let stopping = false;

export function quickTunnelOrigin(output: string): string | null {
  const match = output.match(/https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com\b/i);
  return match ? new URL(match[0]).origin : null;
}

function cloudflaredExecutable(): string {
  const override = process.env.AUTOFORUM_CLOUDFLARED_PATH?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    for (const root of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]) {
      if (!root) continue;
      const candidate = path.join(root, "cloudflared", "cloudflared.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  return "cloudflared";
}

async function portIsAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve(true));
    });
  });
}

async function selectWebPort(): Promise<number> {
  for (let port = DEFAULT_WEB_PORT; port <= 65_535; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error("no_available_share_port");
}

function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  process.exitCode = code;
}

function watch(child: ChildProcess, label: string): void {
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${label} stopped${signal ? ` (${signal})` : ""}.`);
      stop(code ?? 1);
    }
  });
}

async function startQuickTunnel(port: number): Promise<{ child: ChildProcess; origin: string }> {
  const child = spawn(cloudflaredExecutable(), ["tunnel", "--url", `http://127.0.0.1:${port}`], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  watch(child, "Cloudflare tunnel");

  return await new Promise((resolve, reject) => {
    let recent = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error("cloudflare_quick_tunnel_start_timeout"));
    }, TUNNEL_START_TIMEOUT_MS);
    const inspect = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      process.stderr.write(text);
      recent = `${recent}${text}`.slice(-16_384);
      const origin = quickTunnelOrigin(recent);
      if (origin && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, origin });
      }
    };
    child.stdout!.on("data", inspect);
    child.stderr!.on("data", inspect);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(new Error("cloudflared_not_installed"));
      } else reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!settled) reject(new Error(`cloudflare_quick_tunnel_failed:${code ?? -1}`));
    });
  });
}

async function waitUntilReady(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + APPLICATION_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("application_launcher_stopped");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Podman, PostgreSQL, the worker, and Vite can each need a moment on a cold start.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("shared_application_start_timeout");
}

async function ownerLink(origin: string): Promise<string> {
  const database = createDatabase(loadConfig().databaseUrl);
  try {
    const owner = await ensureInstallationOwner(database, "owner");
    const link = await issueSignInLink(database, owner, owner.id);
    return `${origin}/#sign-in=${encodeURIComponent(link.token)}`;
  } finally {
    await database.close();
  }
}

async function main(): Promise<void> {
  const webPort = await selectWebPort();
  console.log("Starting a temporary Cloudflare tunnel...");
  const tunnel = await startQuickTunnel(webPort);
  const localOrigin = `http://app.autoforum.localhost:${webPort}`;
  const environment = {
    ...process.env,
    APP_ORIGIN: localOrigin,
    AUTOFORUM_SHARE_ORIGIN: tunnel.origin,
  };
  const application = spawn(process.execPath, [
    "--experimental-strip-types",
    "--env-file-if-exists=.env",
    "scripts/start.ts",
  ], { env: environment, stdio: "inherit", windowsHide: true });
  watch(application, "Autoforum");

  await waitUntilReady(webPort, application);
  const signIn = await ownerLink(tunnel.origin);
  console.log("\nTemporary Autoforum share is ready.");
  console.log(`Public: ${tunnel.origin}`);
  console.log(`Owner sign-in: ${signIn}`);
  console.log(`Local: ${localOrigin}`);
  console.log("Create invitations while using the public URL so copied links have the public hostname.");
  console.log("Use the local URL for artifact previews and screen sharing. Press Ctrl+C to stop everything.\n");
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "cloudflared_not_installed") {
      console.error("cloudflared is not installed or is not on PATH. Install it from https://developers.cloudflare.com/tunnel/downloads/ and try again.");
    } else {
      console.error(`Temporary sharing failed: ${message}`);
    }
    stop(1);
  });
}
