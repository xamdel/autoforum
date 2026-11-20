import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("discovers a page, serves its bundle, and delegates its API", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "autoforum-shell-test-"));
  const page = path.join(root, "pages", "hello");
  await mkdir(path.join(root, "modules"), { recursive: true });
  await mkdir(path.join(root, "outputs"), { recursive: true });
  await mkdir(page, { recursive: true });
  await writeFile(path.join(page, "page.json"), JSON.stringify({ title: "Hello", description: "A test page", icon: "H" }));
  await writeFile(path.join(page, "page.css"), ".hello-page { color: var(--pompeii); }");
  await writeFile(path.join(page, "page.tsx"), "import './page.css';\nexport default function Page(){ return <main className=\"page hello-page\">Hello workspace</main> }");
  await writeFile(path.join(page, "server.ts"), "export default async function handle(request){ return Response.json({ path: new URL(request.url).pathname }) }");
  const port = 18_000 + Math.floor(Math.random() * 10_000);
  const child = spawn(process.execPath, [path.resolve("server.mjs")], {
    cwd: path.resolve("."),
    env: { ...process.env, PORT: String(port), AUTOFORUM_WORKSPACE_ROOT: root, AUTOFORUM_SHELL_BUILD_ROOT: path.join(root, ".build") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += chunk; });
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  try {
    const deadline = Date.now() + 10_000;
    let response;
    while (Date.now() < deadline) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(response?.ok, diagnostics);
    assert.match(await response.text(), /app\.js/);
    const script = await fetch(`http://127.0.0.1:${port}/__autoforum_workspace/app.js`);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    assert.match(await script.text(), /Hello workspace/);
    // Every page starts from Autoforum's design system: it is bundled first, then the shell's chrome, then the page's own CSS.
    const styles = await (await fetch(`http://127.0.0.1:${port}/__autoforum_workspace/app.css`)).text();
    const order = ["--travertine:", ".workspace-crumbs", ".hello-page"].map((marker) => styles.indexOf(marker));
    assert(order.every((position) => position >= 0), `missing styles: ${order}`);
    assert.deepEqual(order, order.toSorted((left, right) => left - right), "design system, then shell, then page CSS");
    const api = await fetch(`http://127.0.0.1:${port}/api/pages/hello/example`);
    assert.deepEqual(await api.json(), { path: "/example" });
  } finally {
    child.kill();
    await once(child, "exit").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
