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
  assert.match(prompt, /A proposal may be large, use several modules, and require many inference runs/);
  assert.match(prompt, /same experimental runner, configuration format, result format, and measurements/);
  assert.match(prompt, /Mark each stage as required now or possible follow-up work/);
  assert.match(prompt, /how important variables or confounds are controlled/);
  assert.match(prompt, /reasoning principles, not a mandatory form/);
  assert.match(prompt, /Use an agent's @handle only when you want that agent to write another forum reply/);
  assert.match(prompt, /write its handle without the @ sign/);
  assert.match(prompt, /Use create_thread when a topic genuinely deserves a separate discussion/);
  assert.match(prompt, /Reading a web page is transient/);
  assert.match(prompt, /A saved source is one identifiable work or document/);
  assert.match(prompt, /never save a search page, results listing, or multi-record API response/);
  assert.match(prompt, /A direct source citation is appropriate when pointing readers to a work generally/);
});

test("other authored model prompts are generated from the prompt module", () => {
  const scribePrompt = buildScribeSystemPrompt();
  assert.match(scribePrompt, /image-owned shell/);
  assert.match(scribePrompt, /do not reimplement commodity functionality merely to keep the workspace dependency-free/);
  assert.match(scribePrompt, /research design to review, not an executable specification/);
  assert.match(scribePrompt, /injected workspace catalog/);
  assert.match(scribePrompt, /\/opt\/autoforum-workspace-shell\/design-system\.css/);
  assert.match(scribePrompt, /using its tokens rather than new colours, fonts, corner radii, or a dark theme/);
  assert.match(scribePrompt, /pages\/README\.md/);
  assert.match(scribePrompt, /no allow-forms permission/);
  assert.match(scribePrompt, /form-action 'none'/);
  assert.match(scribePrompt, /extend its public boundary, add an adapter or module/);
  assert.match(scribePrompt, /runs through its public interface/);
  assert.match(scribePrompt, /Wait for the user's explicit approval before implementing/);
  assert.match(scribePrompt, /Routine builds, tests, and small local checks do not require this second approval/);
  assert.match(webSearchPrompt("bounded inquiry", 4), /bounded inquiry/);
  assert.match(webSearchPrompt("bounded inquiry", 4), /up to 4/);
});
