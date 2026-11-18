// The reply composer. A post is prose plus, when it helps, structure the author chooses to add: questions, claims,
// evidence, proposals (with the outputs a result should carry), relations between records, and excerpts from the
// project's sources. Each attachment has a short key; the prose can point at it with [[new:key]] before it has an
// address. Nothing is inferred from the prose: what is attached is what is recorded.

import { useState, type FormEvent, type RefObject } from "react";

import { api, type ObjectKind, type PublishInput, type PublishObject, type RelationType, type Source } from "../lib/api.ts";
import { invalidate } from "../lib/query.ts";
import { navigate, path } from "../lib/router.ts";
import { Markdown, plainLine, Reference } from "../components/Markdown.tsx";
import { SmartTextarea, type Suggestion } from "../components/SmartTextarea.tsx";
import { flash, flashFailure, icons, KindIcon } from "../components/ui.tsx";
import { emptyReply, nextKey, useReplyDraft, type DraftExcerpt, type DraftObject, type ReplyDraft } from "../state/drafts.ts";
import { useProject } from "../state/project.tsx";
import { keys, useSources } from "../state/queries.ts";

const KINDS: Array<{ kind: ObjectKind; label: string; prefix: string; hint: string; placeholder: string }> = [
  { kind: "question", label: "Question", prefix: "q", hint: "An unknown that organizes the discussion", placeholder: "What is not known yet?" },
  { kind: "claim", label: "Claim", prefix: "c", hint: "An answer or a position", placeholder: "State the claim on its own, so it can be cited." },
  { kind: "evidence", label: "Evidence", prefix: "e", hint: "An observation or interpretation; it can cite excerpts and results", placeholder: "What was observed, and what it shows." },
  { kind: "proposal", label: "Proposal", prefix: "p", hint: "A request to run a sandbox experiment or build a prototype that yields results", placeholder: "What should the Scribe build or run in the sandbox, and what results should it produce?" },
  { kind: "relation", label: "Relation", prefix: "r", hint: "How one record bears on another", placeholder: "Why (optional)" },
];
const RELATIONS: RelationType[] = ["supports", "opposes", "tests", "implements"];
const OUTPUT_KEY = /^[a-z][a-z0-9_-]{0,63}$/;

const endpoints = (text: string) => [...new Set(text.split(/[\s,]+/).map((part) => part.replace(/^\[\[|\]\]$/g, "").trim()).filter(Boolean))];

/** What is wrong with the draft, in words, or null when it can be posted. */
function problem(draft: ReplyDraft): string | null {
  for (const object of draft.objects) {
    if (object.kind === "relation") {
      if (!endpoints(object.subjects).length || !endpoints(object.objects).length) return `The relation ${object.key} needs at least one address on each side.`;
      continue;
    }
    if (!object.body.trim()) return `The ${object.kind} ${object.key} needs text.`;
    for (const output of object.outputs) {
      if (!OUTPUT_KEY.test(output.key)) return `"${output.key || "(empty)"}" is not a valid output key: lowercase letters, digits, "-" and "_", starting with a letter.`;
    }
    if (new Set(object.outputs.map((output) => output.key)).size !== object.outputs.length) return `The proposal ${object.key} lists an output key twice.`;
  }
  for (const excerpt of draft.excerpts) {
    if (!excerpt.source) return "Choose the source of each excerpt.";
    if (!excerpt.content.trim()) return `The excerpt ${excerpt.key} is empty.`;
  }
  return null;
}

function payload(draft: ReplyDraft): PublishInput {
  return {
    body: draft.body,
    replyTo: draft.replyTo,
    excerpts: draft.excerpts.map((excerpt) => ({ key: excerpt.key, source: excerpt.source, content: excerpt.content, locator: excerpt.locator.trim() || null })),
    objects: draft.objects.map((object): PublishObject => object.kind === "relation"
      ? { key: object.key, kind: "relation", label: object.label.trim() || null, body: object.body.trim() || null, relationType: object.relationType, subjects: endpoints(object.subjects), objects: endpoints(object.objects) }
      : {
          key: object.key,
          kind: object.kind,
          label: object.label.trim() || null,
          body: object.body,
          ...(object.kind === "proposal" && object.outputs.length
            ? { expectedOutputs: Object.fromEntries(object.outputs.map((output) => [output.key, output.note.trim() || "unspecified"])) }
            : {}),
        }),
  };
}

function ObjectEditor({ object, onChange, onRemove, onCite }: { object: DraftObject; onChange(next: DraftObject): void; onRemove(): void; onCite(): void }) {
  const meta = KINDS.find((each) => each.kind === object.kind)!;
  const set = (patch: Partial<DraftObject>) => onChange({ ...object, ...patch });
  return (
    <fieldset className={`attachment record-${object.kind === "relation" ? "rel" : object.kind}`}>
      <legend>
        <KindIcon kind={object.kind} /> {meta.label}
        <button type="button" className="ref pending" title="Point at this attachment from your post" onClick={onCite}>new:{object.key}</button>
        <button type="button" className="icon-button tiny" aria-label={`Remove this ${object.kind}`} title="Remove" onClick={onRemove}>{icons.close}</button>
      </legend>
      {object.kind === "relation" ? (
        <div className="relation-fields">
          <input aria-label="Subjects" value={object.subjects} onChange={(event) => set({ subjects: event.target.value })} placeholder="claim:42, new:e1" spellCheck={false} />
          <select aria-label="Relation" value={object.relationType} onChange={(event) => set({ relationType: event.target.value as RelationType })}>
            {RELATIONS.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
          <input aria-label="Objects" value={object.objects} onChange={(event) => set({ objects: event.target.value })} placeholder="claim:17" spellCheck={false} />
        </div>
      ) : (
        <input aria-label="Label" value={object.label} onChange={(event) => set({ label: event.target.value })} maxLength={200} placeholder="Short label (optional)" />
      )}
      <textarea aria-label={`${meta.label} text`} rows={object.kind === "relation" ? 1 : 3} value={object.body} onChange={(event) => set({ body: event.target.value })} placeholder={meta.placeholder} />
      {object.kind === "proposal" ? (
        <div className="outputs-editor">
          <div className="muted small">Expected outputs: the keys a result for this proposal should carry</div>
          {object.outputs.map((output, index) => (
            <div className="output-row" key={index}>
              <input aria-label="Output key" value={output.key} spellCheck={false} placeholder="temperature_over_time" onChange={(event) => set({ outputs: object.outputs.map((each, at) => (at === index ? { ...each, key: event.target.value } : each)) })} />
              <input aria-label="What it should hold" value={output.note} placeholder="what it should hold, e.g. number[] in °C" onChange={(event) => set({ outputs: object.outputs.map((each, at) => (at === index ? { ...each, note: event.target.value } : each)) })} />
              <button type="button" className="icon-button tiny" aria-label="Remove this output" onClick={() => set({ outputs: object.outputs.filter((_each, at) => at !== index) })}>{icons.close}</button>
            </div>
          ))}
          <button type="button" className="link small" onClick={() => set({ outputs: [...object.outputs, { key: "", note: "" }] })}>+ expected output</button>
        </div>
      ) : null}
    </fieldset>
  );
}

function ExcerptEditor({ excerpt, sources, onChange, onRemove, onCite }: { excerpt: DraftExcerpt; sources: Source[]; onChange(next: DraftExcerpt): void; onRemove(): void; onCite(): void }) {
  const set = (patch: Partial<DraftExcerpt>) => onChange({ ...excerpt, ...patch });
  return (
    <fieldset className="attachment record-excerpt">
      <legend>
        <KindIcon kind="excerpt" /> Excerpt
        <button type="button" className="ref pending" title="Point at this attachment from your post" onClick={onCite}>new:{excerpt.key}</button>
        <button type="button" className="icon-button tiny" aria-label="Remove this excerpt" title="Remove" onClick={onRemove}>{icons.close}</button>
      </legend>
      <div className="excerpt-fields">
        <select aria-label="Source" value={excerpt.source} onChange={(event) => set({ source: event.target.value })}>
          <option value="">Choose a source…</option>
          {sources.map((source) => <option key={source.id} value={source.address}>{source.title}</option>)}
        </select>
        <input aria-label="Where in the source" value={excerpt.locator} onChange={(event) => set({ locator: event.target.value })} maxLength={500} placeholder="p. 14, Table 2, §3.1 (optional)" />
      </div>
      <textarea aria-label="Excerpt" rows={3} value={excerpt.content} onChange={(event) => set({ content: event.target.value })} placeholder="The passage, numbers, or table exactly as the source has it." />
    </fieldset>
  );
}

export function Composer({ threadId, nearby, input }: { threadId: number; nearby: Suggestion[]; input: RefObject<HTMLTextAreaElement | null> }) {
  const { projectId, user, isOwner, members } = useProject();
  const [draft, setDraft] = useReplyDraft(projectId, threadId);
  const sources = useSources(projectId);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const agents = members.filter((member) => member.kind === "agent");

  const cite = (key: string) => {
    const element = input.current;
    const at = element ? element.selectionStart : draft.body.length;
    const text = `[[new:${key}]]`;
    setDraft({ ...draft, body: draft.body.slice(0, at) + text + draft.body.slice(element ? element.selectionEnd : at) });
    window.setTimeout(() => {
      element?.focus();
      if (element) element.selectionStart = element.selectionEnd = at + text.length;
    }, 0);
  };
  const attach = (kind: ObjectKind, prefix: string) => setDraft({
    ...draft,
    objects: [...draft.objects, { key: nextKey(prefix, draft), kind, label: "", body: "", outputs: [], relationType: "supports", subjects: "", objects: "" }],
  });
  const attachExcerpt = () => setDraft({
    ...draft,
    excerpts: [...draft.excerpts, { key: nextKey("x", draft), source: sources.data?.length === 1 ? sources.data[0]!.address : "", content: "", locator: "" }],
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wrong = problem(draft);
    if (wrong) return flash(wrong);
    setBusy(true);
    api<{ post: string; turnIds: number[] }>(`/projects/${projectId}/threads/${threadId}/posts`, { method: "POST", json: payload(draft) }).then((result) => {
      setDraft(emptyReply());
      setPreview(false);
      invalidate(keys.thread(projectId, threadId));
      invalidate(keys.threads(projectId));
      invalidate(keys.turns(projectId));
      invalidate(keys.projects);
      navigate(`${path(projectId, "t", threadId)}?at=${encodeURIComponent(result.post)}`, { replace: true });
    }, flashFailure).finally(() => setBusy(false));
  };

  const own: Suggestion[] = [
    ...draft.objects.map((object) => ({ label: plainLine(object.label || object.body, 60) || `this post's ${object.kind}`, detail: `new:${object.key}`, insert: `[[new:${object.key}]]`, kind: object.kind })),
    ...draft.excerpts.map((excerpt) => ({ label: plainLine(excerpt.content, 60) || "this post's excerpt", detail: `new:${excerpt.key}`, insert: `[[new:${excerpt.key}]]`, kind: "excerpt" })),
  ];
  const attached = draft.objects.length + draft.excerpts.length;

  return (
    <form className="card form composer" id="composer" onSubmit={submit}>
      {draft.replyTo ? (
        <div className="reply-target small">
          {icons.reply} Replying to <Reference address={draft.replyTo} projectId={projectId} />
          <button type="button" className="link" onClick={() => setDraft({ ...draft, replyTo: null })}>cancel</button>
        </div>
      ) : null}
      <SmartTextarea
        textareaRef={input}
        id="composer-input"
        rows={5}
        value={draft.body}
        onValue={(body) => setDraft({ ...draft, body })}
        nearby={[...own, ...nearby]}
        required
        maxLength={100_000}
        aria-label="Your reply"
        placeholder={`Write a reply in Markdown. @ mentions a member${isOwner && agents.length ? " (an agent you mention will answer)" : ""}; [[ links a post, a claim, a source, a result.`}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) event.currentTarget.form?.requestSubmit();
        }}
      />

      {draft.objects.map((object, index) => (
        <ObjectEditor
          key={object.key}
          object={object}
          onCite={() => cite(object.key)}
          onChange={(next) => setDraft({ ...draft, objects: draft.objects.map((each, at) => (at === index ? next : each)) })}
          onRemove={() => setDraft({ ...draft, objects: draft.objects.filter((_each, at) => at !== index) })}
        />
      ))}
      {draft.excerpts.map((excerpt, index) => (
        <ExcerptEditor
          key={excerpt.key}
          excerpt={excerpt}
          sources={sources.data ?? []}
          onCite={() => cite(excerpt.key)}
          onChange={(next) => setDraft({ ...draft, excerpts: draft.excerpts.map((each, at) => (at === index ? next : each)) })}
          onRemove={() => setDraft({ ...draft, excerpts: draft.excerpts.filter((_each, at) => at !== index) })}
        />
      ))}

      <div className="attach-bar" role="group" aria-label="Attach a record to this post">
        <span className="muted small">Attach</span>
        {KINDS.map((each) => (
          <button type="button" key={each.kind} className="attach" title={each.hint} onClick={() => attach(each.kind, each.prefix)}><KindIcon kind={each.kind} /> {each.label}</button>
        ))}
        <button type="button" className="attach" title={sources.data?.length ? "A passage from one of the project's sources" : "Add a source in the Library first"} disabled={!sources.data?.length} onClick={attachExcerpt}><KindIcon kind="excerpt" /> Excerpt</button>
      </div>

      <div className="row">
        <button className="primary" type="submit" disabled={busy || !draft.body.trim()}>{attached ? `Post reply with ${attached} attached` : "Post reply"}</button>
        <button type="button" onClick={() => setPreview(!preview)} aria-pressed={preview}>Preview</button>
        <span className="muted small push">Posting as @{user.handle} · Ctrl+Enter posts</span>
      </div>
      {preview && draft.body.trim() ? <div className="preview"><Markdown text={draft.body} /></div> : null}
    </form>
  );
}
