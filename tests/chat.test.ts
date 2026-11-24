import assert from "node:assert/strict";
import test from "node:test";

import { describeScribeToolActivity, reconcileScribeConversations } from "../src/chat.ts";
import type { AppDatabase } from "../src/db.ts";
import { renderScribeHistory, renderWorkspaceCatalog, scribeSystemPrompt } from "../src/scribe.ts";

test("Scribe history preserves roles and the latest bounded conversation suffix", () => {
  const history = Array.from({ length: 45 }, (_, index) => ({
    role: index % 2 ? "assistant" as const : "user" as const,
    body: `message-${index}`,
  }));
  const rendered = renderScribeHistory(history);

  assert.doesNotMatch(rendered, /message-0(?:\D|$)/);
  assert.match(rendered, /## User\n\nmessage-44/);
  assert.match(rendered, /## Scribe\n\nmessage-43/);
});

test("Scribe history truncates a single oversized message", () => {
  const rendered = renderScribeHistory([{ role: "user", body: "x".repeat(25_000) }]);
  assert.match(rendered, /\[message truncated\]$/);
  assert.ok(rendered.length < 21_000);
});

test("the injected workspace catalog contains bounded architectural entries rather than a file tree", () => {
  const rendered = renderWorkspaceCatalog({
    pages: [{ name: "workflow-lab", description: "Edits and runs project workflow graphs." }],
    modules: [{ name: "geometry", description: null }],
  });
  assert.match(rendered, /workflow-lab .* Edits and runs project workflow graphs/);
  assert.match(rendered, /geometry .* description missing/);
  assert.match(rendered, /## Pages/);
  assert.match(rendered, /## Reusable modules/);
  assert.doesNotMatch(rendered, /node_modules/);
  assert.match(renderWorkspaceCatalog(null), /Do not assume that the workspace is empty/);
});

test("the Scribe has sandbox tools without treating the sandbox as host access", () => {
  const prompt = scribeSystemPrompt();
  assert.match(prompt, /persistent \/workspace/);
  assert.match(prompt, /run_workspace_command/);
  assert.match(prompt, /only do so when the user's request calls for workspace work/);
  assert.match(prompt, /A request to draft, rewrite, or summarize is a writing request/);
  assert.match(prompt, /Tools are optional/);
  assert.match(prompt, /only when new outside research is called for/);
  assert.match(prompt, /normal development environment/);
  assert.match(prompt, /one persistent, evolving project/);
  assert.match(prompt, /under pages\/.*under modules\//s);
  assert.match(prompt, /Reuse is subordinate to experimental fidelity/);
  assert.match(prompt, /Never change the mechanism, procedure, variables, controls/);
  assert.match(prompt, /name it after its function/);
  assert.match(prompt, /how important variables or confounds are controlled/);
  assert.match(prompt, /same experimental runner, configuration format, result format, and measurements/);
  assert.match(prompt, /explicit approval before implementing/);
  assert.match(prompt, /explicit approval to run it/);
  assert.match(prompt, /Use web_search/);
  assert.match(prompt, /read_web/);
  assert.match(prompt, /search summaries are leads, not evidence/);
  assert.match(prompt, /logged and cached but does not add it to the project Library/);
  assert.match(prompt, /one identifiable work or document/);
  assert.match(prompt, /never save a search page, results listing, or multi-record API response/);
  assert.match(prompt, /direct source citation may point readers to a work generally/);
  assert.match(prompt, /sandbox_not_running/);
  assert.match(prompt, /no host access/);
  assert.match(prompt, /Git commit/);
  assert.match(prompt, /image-owned shell automatically discovers and rebuilds pages/);
  assert.match(prompt, /native form submission is deliberately blocked/);
  assert.match(prompt, /type="button" with onClick/);
  assert.match(prompt, /Browser storage is scoped to the short-lived preview origin/);
  assert.match(prompt, /Writes under pages\/ and modules\/ report the corresponding shell build result/);
  assert.match(prompt, /call workspace_status yourself/);
  assert.match(prompt, /latest shell build has finished without an error/);
  assert.match(prompt, /never ask the user to visit a sandbox localhost address/);
  assert.match(prompt, /pages\/<slug>\/server\.ts/);
  assert.match(prompt, /\/api\/pages\/<slug>\/\*/);
  assert.match(prompt, /outputs itself must never be an array/);
  assert.match(prompt, /use its expected result output names as those keys/);
  assert.match(prompt, /generic file manifest or path\/hash\/size receipts/);
});

test("a member Scribe is a private research assistant without workspace authority", () => {
  const prompt = scribeSystemPrompt(false);
  assert.match(prompt, /private chat with one project member/);
  assert.match(prompt, /web_search/);
  assert.match(prompt, /A request to draft, rewrite, or summarize is a writing request/);
  assert.match(prompt, /Tools are optional/);
  assert.match(prompt, /one identifiable work or document/);
  assert.match(prompt, /or access the project workspace or sandbox/);
  assert.doesNotMatch(prompt, /run_workspace_command/);
  assert.doesNotMatch(prompt, /persistent \/workspace/);
});

test("live Scribe activity describes tool calls without exposing file contents or shell scripts", () => {
  assert.equal(describeScribeToolActivity({
    phase: "start",
    callId: "write-1",
    toolName: "write_workspace_file",
    input: { path: "pilot/run.py", content: "SECRET_FILE_CONTENT" },
  }), "Writing pilot/run.py…");
  assert.equal(describeScribeToolActivity({
    phase: "start",
    callId: "command-1",
    toolName: "run_workspace_command",
    input: { argv: ["sh", "-lc", "curl -H 'Authorization: SECRET' https://example.test"] },
  }), "Running a workspace command…");
  assert.equal(describeScribeToolActivity({
    phase: "start",
    callId: "status-1",
    toolName: "workspace_status",
    input: {},
  }), "Checking the workspace build…");
  assert.equal(describeScribeToolActivity({
    phase: "start",
    callId: "save-1",
    toolName: "save_source",
    input: { url: "https://example.test/private-query" },
  }), "Saving a source from “https://example.test/private-query”…");
});

test("startup releases Scribe conversations interrupted by the previous process", async () => {
  let statement = "";
  const database = {
    pool: {
      async query(sql: string) {
        statement = sql;
        return { rowCount: 2 };
      },
    },
  } as unknown as AppDatabase;

  assert.equal(await reconcileScribeConversations(database), 2);
  assert.match(statement, /set status = 'idle'/);
  assert.match(statement, /where status = 'running'/);
});
