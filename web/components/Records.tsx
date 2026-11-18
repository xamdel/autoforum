// How the forum's records look wherever they appear (under the post that introduced them, in the dock): discourse
// objects (question, claim, evidence, proposal, relation), source excerpts, and imported results.

import { memo } from "react";

import type { DiscourseObject, ForumResult } from "../lib/api.ts";
import { plural } from "../lib/format.ts";
import { openDockView } from "../state/dock.ts";
import { Markdown, Reference } from "./Markdown.tsx";
import { AddressChip, Badge, icons, KindIcon, Time } from "./ui.tsx";

const RELATION_WORDS: Record<string, string> = { supports: "supports", opposes: "opposes", tests: "tests", implements: "implements" };

export function jsonText(value: unknown, limit = 6_000): string {
  const rendered = JSON.stringify(value, null, 2) ?? "null";
  return rendered.length <= limit ? rendered : `${rendered.slice(0, limit)}\n… (${(rendered.length - limit).toLocaleString()} more characters)`;
}

/** What a value is, in a few words: its shape, never its meaning. */
export function shapeOf(value: unknown): string {
  if (Array.isArray(value)) {
    const kinds = new Set(value.map((item) => (item === null ? "null" : Array.isArray(item) ? "array" : typeof item)));
    return `${value.length.toLocaleString()} ${kinds.size === 1 ? `${[...kinds][0]}${value.length === 1 ? "" : "s"}` : value.length === 1 ? "item" : "items"}`;
  }
  if (value === null) return "null";
  if (typeof value === "object") return plural(Object.keys(value).length, "key");
  return typeof value;
}

const isScalar = (value: unknown) => value === null || typeof value !== "object";

/** A result's outputs, each under the address that cites it. */
export function ResultOutputs({ result, open = false }: { result: ForumResult; open?: boolean }) {
  return (
    <div className="outputs">
      {Object.entries(result.outputs).map(([key, value]) => (
        isScalar(value) ? (
          <div className="output scalar" key={key}>
            <span className="output-key">{key}</span>
            <code className="output-value">{String(typeof value === "string" ? value : JSON.stringify(value))}</code>
            <AddressChip address={`${result.address}#${key}`} />
          </div>
        ) : (
          <details className="output" key={key} open={open}>
            <summary>
              <span className="output-key">{key}</span>
              <span className="muted small">{shapeOf(value)}</span>
              <AddressChip address={`${result.address}#${key}`} />
            </summary>
            <pre>{jsonText(value)}</pre>
          </details>
        )
      ))}
      {result.missingOutputs.length ? <p className="output-note bad">Expected but missing: {result.missingOutputs.map((key) => <code key={key}>{key}</code>)}</p> : null}
      {result.additionalOutputs.length ? <p className="output-note">Beyond what was expected: {result.additionalOutputs.map((key) => <code key={key}>{key}</code>)}</p> : null}
    </div>
  );
}

/** A result as one clickable line: its address, what it answers, and whether anything expected is missing. */
export function ResultRow({ result, threadId, active }: { result: ForumResult; threadId: number; active?: boolean }) {
  const count = Object.keys(result.outputs).length;
  return (
    <button type="button" className={`mn-row ${active ? "on" : ""}`} title="Open beside the page" data-address={result.address} onClick={() => openDockView({ kind: "result", address: result.address, threadId })}>
      <KindIcon kind="result" />
      <span className="mn-row-text">
        <b>{result.address}</b>
        <span className="muted small">
          {plural(count, "output")} · <Time at={result.createdAt} />
          {result.missingOutputs.length ? <span className="bad"> · {result.missingOutputs.length} missing</span> : null}
        </span>
      </span>
    </button>
  );
}

export const ObjectCard = memo(function ObjectCard({ object, results, threadId, projectId, highlight }: {
  object: DiscourseObject;
  results?: ForumResult[];
  threadId: number;
  projectId: number;
  highlight?: boolean;
}) {
  const relation = object.kind === "relation";
  const expected = object.expectedOutputs ? Object.entries(object.expectedOutputs) : [];
  return (
    <section className={`record record-${relation ? "rel" : object.kind} ${highlight ? "highlight" : ""}`} data-address={object.address}>
      <header className="record-head">
        <KindIcon kind={object.kind} />
        <span className="record-kind">{object.kind}</span>
        {object.label ? <b className="record-label">{object.label}</b> : null}
        <AddressChip address={object.address} />
      </header>
      {relation ? (
        <p className="relation-line">
          {(object.subjects ?? []).map((address) => <Reference key={address} address={address} projectId={projectId} />)}
          <span className={`relation-type relation-${object.relationType}`}>{RELATION_WORDS[object.relationType ?? ""] ?? object.relationType}</span>
          {(object.objects ?? []).map((address) => <Reference key={address} address={address} projectId={projectId} />)}
        </p>
      ) : null}
      {object.body ? <Markdown text={object.body} /> : null}
      {object.kind === "proposal" ? (
        <footer className="record-foot">
          {expected.length ? <span className="muted small">expects {expected.map(([key]) => <code key={key}>{key}</code>)}</span> : null}
          {results?.length
            ? <Badge tone={results.some((result) => result.missingOutputs.length) ? "busy" : "good"}>{plural(results.length, "result")}</Badge>
            : <Badge tone="open">no results yet</Badge>}
          <button type="button" className="link record-open" onClick={() => openDockView({ kind: "proposal", address: object.address, threadId })}>Open {icons.caret}</button>
        </footer>
      ) : null}
    </section>
  );
});
