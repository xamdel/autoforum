import assert from "node:assert/strict";
import test from "node:test";

import {
  agentSystemPrompt,
  buildScribeSystemPrompt,
  DEFAULT_AGENTS,
  webSearchPrompt,
} from "../src/prompts.ts";

test("the default roster has distinct valid handles and restrained personas", () => {
  assert.equal(DEFAULT_AGENTS.length, 6);
  assert.equal(new Set(DEFAULT_AGENTS.map((agent) => agent.handle)).size, DEFAULT_AGENTS.length);
  for (const agent of DEFAULT_AGENTS) {
    assert.match(agent.handle, /^[a-z][a-z0-9_-]{1,31}$/);
    assert.ok(agent.systemPrompt.length > 40);
    assert.match(agent.systemPrompt, /well-rounded research participant/);
    assert.match(agent.systemPrompt, /additional strength/);
  }
  assert.match(DEFAULT_AGENTS.find((agent) => agent.handle === "hopper")!.systemPrompt, /not a requirement to force an implementation frame/);
  assert.match(DEFAULT_AGENTS.find((agent) => agent.handle === "helix-omega")!.systemPrompt, /not your assigned function/);
  assert.match(DEFAULT_AGENTS.find((agent) => agent.handle === "scribe")!.systemPrompt, /no workspace access/);
});

test("agent personas receive the one shared forum contract", () => {
  const prompt = agentSystemPrompt("A deliberately short persona.");
  assert.match(prompt, /^A deliberately short persona\./);
  assert.match(prompt, /not a specialist confined to the profile/);
  assert.match(prompt, /not a checklist, standing task, or boundary/);
  assert.match(prompt, /Never manufacture a problem, experiment, source, or connection/);
  assert.match(prompt, /thoughtful collaborator/);
  assert.match(prompt, /A brief reply may introduce no objects/);
  assert.match(prompt, /Questions may be broad and exploratory or precise and specifically testable/);
  assert.match(prompt, /explicitly asked to identify or pose research questions, create question objects/);
  assert.match(prompt, /Leave rhetorical, incidental, and short-lived conversational questions in prose/);
  assert.match(prompt, /persistent, general-purpose programmable project sandbox/);
  assert.match(prompt, /part of your role is to notice important uncertainties that programmable work could resolve/);
  assert.match(prompt, /Do not wait for the owner to suggest a test/);
  assert.match(prompt, /simulation, data analysis, benchmark, evaluator, data-gathering tool, visualization, interactive demonstration, or custom program/);
  assert.match(prompt, /returns its outputs to the forum as results for continued discussion/);
  assert.match(prompt, /Research plans, taxonomies, methodological advice, operating guidelines/);
  assert.match(prompt, /Prefer one primary question and the smallest useful test/);
  assert.match(prompt, /how important variables or confounds are isolated/);
  assert.match(prompt, /reasoning principles, not a mandatory form/);
  assert.match(prompt, /do not tag agents merely to prolong/);
  assert.match(prompt, /Use create_thread when a topic genuinely deserves a separate discussion/);
  assert.match(prompt, /Reading a web page is transient/);
  assert.match(prompt, /Use save_source, with an accurate human-readable title/);
  assert.match(prompt, /A direct source citation is appropriate when pointing readers to a work generally/);
});

test("other authored model prompts are generated from the prompt module", () => {
  const scribePrompt = buildScribeSystemPrompt("0.0.0.0", 8080);
  assert.match(scribePrompt, /HOST=0\.0\.0\.0 and PORT=8080/);
  assert.match(scribePrompt, /do not reimplement commodity functionality merely to keep the workspace dependency-free/);
  assert.match(scribePrompt, /research design to review, not an executable specification/);
  assert.match(scribePrompt, /Wait for the owner's explicit approval before implementing/);
  assert.match(scribePrompt, /Routine builds, tests, and small local checks do not require this second approval/);
  assert.match(webSearchPrompt("bounded inquiry", 4), /bounded inquiry/);
  assert.match(webSearchPrompt("bounded inquiry", 4), /up to 4/);
});
