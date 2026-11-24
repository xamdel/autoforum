import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function runFilesystemHelper(root: string, statusUrl: string, request: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
  const child = spawn(process.execPath, [path.resolve("sandbox/filesystem.mjs"), encoded], {
    env: { ...process.env, AUTOFORUM_WORKSPACE_ROOT: root, AUTOFORUM_SHELL_STATUS_URL: statusUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, Buffer.concat(stderr).toString("utf8"));
  return JSON.parse(Buffer.concat(stdout).toString("utf8"));
}

test("workspace file writes return the shell build error triggered by that write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "autoforum-filesystem-test-"));
  await mkdir(path.join(root, "pages", "demo"), { recursive: true });
  let statusReads = 0;
  const server = http.createServer((_request, response) => {
    statusReads += 1;
    const failed = statusReads > 1;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      revision: 4,
      buildNumber: failed ? 8 : 7,
      building: false,
      error: failed ? "Unexpected closing button tag" : null,
      pages: [],
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    const result = await runFilesystemHelper(root, `http://127.0.0.1:${address.port}/status`, {
      operation: "write",
      path: "pages/demo/page.tsx",
      content: Buffer.from("export default function Page(){ return <output>Broken</button> }").toString("base64"),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result.build, {
      state: "failed",
      revision: 4,
      buildNumber: 8,
      error: "Unexpected closing button tag",
    });
    assert.match(await readFile(path.join(root, "pages", "demo", "page.tsx"), "utf8"), /Broken/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
