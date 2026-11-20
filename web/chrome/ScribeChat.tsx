// The Scribe's chat: the one place you talk to it, docked beside whatever page you are on. Everything else that
// mentions the Scribe ("Ask the Scribe" on a post or proposal) opens this with something to start from.
//
// A conversation is private to you. Its header names it and switches between conversations; a bar under the header
// says what it is about when it was started from a thread or a record. Your messages sit on the right; the Scribe's
// replies read as documents on the left, each with ways to carry it into the forum (as a reply or a new thread: a
// draft is ordinary text in the normal composer, posted under your name only when you post it). The model it is
// asked with is a chip in the composer.

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import { api, type AgentRecord, type ChatMessage, type Conversation, type ThinkingLevel } from "../lib/api.ts";
import { describeError, plural } from "../lib/format.ts";
import { invalidate } from "../lib/query.ts";
import { addressLink, navigate, path, useRoute } from "../lib/router.ts";
import { Markdown, plainLine } from "../components/Markdown.tsx";
import { ModelPicker } from "../components/ModelPicker.tsx";
import { SmartTextarea } from "../components/SmartTextarea.tsx";
import {
  copyText, Dots, flash, flashFailure, icons, KindIcon, PanelFrame, Popover, Time, Timer, useAutoGrow,
} from "../components/ui.tsx";
import { hideScribe } from "../state/dock.ts";
import { appendToReply, appendToThreadDraft, recentThread } from "../state/drafts.ts";
import { useProject } from "../state/project.tsx";
import { keys, useAgents, useConversations, useMessages, useModelApiKeys, usePreview, useSandbox } from "../state/queries.ts";
import {
  chat, dismissFailure, modelIsSet, scribeModel, scribeModelNeedsDefault, selectChat, sendToScribe, setScribeModel, stopScribe, takePrefill, type ScribeModel,
} from "../state/scribe.ts";

/** Unsent text, by conversation, so closing the dock or switching conversations never loses it. */
const unsent = new Map<string, string>();

const THINKING: Array<[ThinkingLevel, string]> = [
  ["off", "Off"], ["minimal", "Minimal"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"],
];

const titleOf = (conversation: Conversation | undefined) => (conversation ? plainLine(conversation.preview, 64) || "New conversation" : "New conversation");

// ---------------------------------------------------------------------------------------------- the model chip

export function ModelForm({ model, agents, showAgentShortcuts = false, update = setScribeModel, save }: {
  model: ScribeModel;
  agents: AgentRecord[];
  showAgentShortcuts?: boolean;
  update?(model: ScribeModel): void;
  save?: { disabled: boolean; run(): void };
}) {
  const { isOwner } = useProject();
  const apiKeys = useModelApiKeys(isOwner);
  const profiles = agents.filter((agent) => agent.profile && !agent.disabledAt);
  const providers = [...new Set([
    model.provider,
    "chatgpt",
    "claude-code",
    ...profiles.map((agent) => agent.profile!.provider),
    ...(apiKeys.data ?? []).filter((provider) => provider.configured).map((provider) => provider.id),
  ].filter(Boolean))].sort();
  return (
    <div className="model-form form">
      {save ? <div className="model-form-save"><button type="button" className="primary" disabled={save.disabled} onClick={save.run}>Save</button></div> : null}
      <label>
        Provider
        <select value={model.provider} onChange={(event) => update({ ...model, provider: event.target.value, model: "" })}>
          {!model.provider ? <option value="">Choose a provider</option> : null}
          {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
        </select>
      </label>
      <label>
        Model
        <ModelPicker provider={model.provider} value={model.model} onChange={(selected) => update({ ...model, model: selected })} />
      </label>
      <label>
        Thinking
        <select value={model.thinkingLevel} onChange={(event) => update({ ...model, thinkingLevel: event.target.value as ThinkingLevel })}>
          {THINKING.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {model.provider === "chatgpt" ? <p className="muted small">Uses the installation's connected ChatGPT plan.</p> : null}
      {model.provider === "claude-code" ? <p className="muted small">Uses your official Claude Code login on this computer. This provider is available to the Scribe only.</p> : null}
      {showAgentShortcuts && profiles.length ? (
        <div className="model-same small">
          <span className="muted">Same as</span>
          {profiles.slice(0, 6).map((agent) => (
            <button type="button" className="link" key={agent.userId} onClick={() => update({ provider: agent.profile!.provider, model: agent.profile!.model, thinkingLevel: agent.profile!.thinkingLevel })}>
              @{agent.handle}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- messages

const Message = memo(function Message({ message, replyTarget, projectId }: {
  message: ChatMessage;
  replyTarget: { threadId: number; title: string } | null;
  projectId: number;
}) {
  if (message.role === "system") return <div className="chat-note">{message.body}</div>;
  if (message.role === "user") {
    return (
      <div className="msg mine">
        <Markdown text={message.body} />
      </div>
    );
  }
  return (
    <article className="msg scribe">
      <div className="msg-who">{icons.quill} Scribe <span className="muted"><Time at={message.createdAt} /></span></div>
      <Markdown text={message.body} />
      <div className="msg-actions">
        <button type="button" className="link" onClick={() => void copyText(message.body)}>Copy</button>
        {replyTarget ? (
          <button
            type="button"
            className="link"
            title={`Add this to your reply draft in “${replyTarget.title}”. Nothing is posted until you post it.`}
            onClick={() => {
              appendToReply(projectId, replyTarget.threadId, message.body);
              navigate(`${path(projectId, "t", replyTarget.threadId)}?compose=1`);
              flash("Added to your reply draft", "ok");
            }}
          >
            Use as reply
          </button>
        ) : null}
        <button
          type="button"
          className="link"
          title="Start a new thread with this as its opening post. Nothing is posted until you post it."
          onClick={() => {
            appendToThreadDraft(projectId, message.body);
            navigate(`${path(projectId, "forum")}?new=1`);
          }}
        >
          Use as new thread
        </button>
      </div>
    </article>
  );
});

function AnchorBar({ projectId, address, onClear }: { projectId: number; address: string; onClear?: () => void }) {
  const preview = usePreview(projectId, address);
  const kind = address.slice(0, address.indexOf(":"));
  return (
    <div className="chat-anchor small">
      <span className="muted">About</span>
      <KindIcon kind={kind} />
      <a href={addressLink(projectId, address)} data-ref={address}>{address}</a>
      <span className="chat-anchor-title">{preview.data ? plainLine(preview.data.heading, 80) : ""}</span>
      {onClear ? <button type="button" className="icon-button tiny" title="Make this a general conversation" aria-label="Remove the anchor" onClick={onClear}>{icons.close}</button> : null}
    </div>
  );
}

function suggestionsFor(page: string | undefined, anchor: string | null): string[] {
  if (anchor) return [`Summarize the discussion in [[${anchor}]] so far.`, `Which claims in [[${anchor}]] still lack evidence?`, `Draft a reply for [[${anchor}]] that `];
  if (page === "workspace") return ["What is in the workspace right now?", "Build a workspace page that ", "Run the project's tests and tell me what fails."];
  return ["What has this project been discussing lately?", "Find what the forum says about ", "Draft a new thread about "];
}

// ---------------------------------------------------------------------------------------------- one conversation

function ConversationView({ selected, conversation, agents }: { selected: number | "new"; conversation: Conversation | undefined; agents: AgentRecord[] }) {
  const { projectId, project, isOwner } = useProject();
  const route = useRoute();
  const state = chat.use();
  const ownerModel = scribeModel.use();
  const model: ScribeModel = isOwner ? ownerModel : {
    provider: project.scribeProvider ?? "",
    model: project.scribeModel ?? "",
    thinkingLevel: project.scribeThinkingLevel,
  };
  const draftKey = `${projectId}:${selected}`;
  const [text, setText] = useState(() => unsent.get(draftKey) ?? "");
  const [stopping, setStopping] = useState(false);
  const messages = useMessages(projectId, conversation?.id ?? null);
  const pending = conversation ? state.pending[conversation.id] : undefined;
  const running = Boolean(pending) || conversation?.status === "running";
  const failure = conversation ? state.failures[conversation.id] : undefined;
  const sandbox = useSandbox(projectId, isOwner, running);
  const anchor = conversation ? conversation.anchor : state.anchors[projectId] ?? null;
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useAutoGrow(text);
  const list = messages.data ?? [];
  const waitingToShow = pending && list.length <= pending.base;

  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);

  const write = (next: string) => {
    setText(next);
    if (next) unsent.set(draftKey, next);
    else unsent.delete(draftKey);
  };

  // The list of conversations says when this one has changed; its messages are fetched again only then.
  const stamp = conversation ? `${conversation.messageCount}:${conversation.status}` : "";
  useEffect(() => {
    if (conversation) invalidate(keys.messages(projectId, conversation.id));
  }, [stamp, projectId, conversation?.id]);

  useLayoutEffect(() => {
    if (log.current && stick.current) log.current.scrollTop = log.current.scrollHeight;
  }, [messages.data, running, waitingToShow, failure]);

  useEffect(() => {
    const timer = window.setTimeout(() => input.current?.focus({ preventScroll: true }), 30);
    return () => window.clearTimeout(timer);
  }, [input]);

  // Text handed over from elsewhere joins what is being typed.
  useEffect(() => {
    if (state.prefill?.projectId !== projectId) return;
    const handed = state.prefill.text;
    takePrefill();
    setText((current) => {
      const next = current.trim() ? `${current.trimEnd()}\n${handed}` : handed;
      unsent.set(draftKey, next);
      return next;
    });
    window.setTimeout(() => {
      const element = input.current;
      if (!element) return;
      element.focus();
      element.selectionStart = element.selectionEnd = element.value.length;
    }, 30);
  }, [state.prefill, projectId, draftKey, input]);

  const ready = modelIsSet(model);
  const send = () => {
    const body = text.trim();
    if (!body || running) return;
    if (!ready) return flash(isOwner ? "Choose the Scribe's model first (the chip under the message box)." : "The owner has not configured the Scribe's model yet.");
    write("");
    stick.current = true;
    sendToScribe(projectId, selected, body, list.length, model).catch((error: unknown) => {
      flash(describeError(error));
      write(body);
    });
  };

  // The thread being read (or the last one read) is where "Use as reply" puts a draft.
  const replyTarget = recentThread(projectId);
  const stopped = isOwner && sandbox.data && sandbox.data.state !== "running";

  return (
    <div className="chat">
      {anchor ? <AnchorBar projectId={projectId} address={anchor} onClear={conversation ? undefined : () => selectChat(projectId, "new", null)} /> : null}
      <div
        className="chat-log"
        ref={log}
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
        }}
      >
        {!list.length && !waitingToShow && !messages.loading ? (
          <div className="chat-intro">
            <span className="chat-intro-mark">{icons.quill}</span>
            <h3>Ask the Scribe</h3>
            <p>{isOwner
              ? "It reads this project's forum and sources, drafts posts for you to publish, and builds and runs things in the project sandbox. This conversation is private to you."
              : "It reads this project's forum and sources, researches the web, and drafts posts for you to publish. This conversation is private to you; it cannot access the shared sandbox."}</p>
            <div className="chat-starters">
              {suggestionsFor(route.segments[1], anchor).map((starter) => (
                <button type="button" key={starter} onClick={() => (write(starter), input.current?.focus())}>{starter.trimEnd()}{starter.endsWith(" ") ? "…" : ""}</button>
              ))}
            </div>
          </div>
        ) : null}
        {list.map((message) => <Message key={message.id} message={message} replyTarget={replyTarget} projectId={projectId} />)}
        {waitingToShow ? <div className="msg mine sending"><Markdown text={pending.body} /></div> : null}
        {running ? (
          <div className="msg working" role="status">
            <Dots />
            <span>The Scribe is working</span>
            <Timer since={pending?.startedAt ?? conversation?.updatedAt ?? Date.now()} />
            <button
              type="button"
              className="link scribe-stop"
              disabled={stopping || !conversation}
              onClick={() => {
                if (!conversation) return;
                setStopping(true);
                void stopScribe(projectId, conversation.id).catch((error: unknown) => {
                  setStopping(false);
                  flash(describeError(error));
                });
              }}
            >
              {stopping ? "Stopping…" : "Stop"}
            </button>
            <span className="muted working-note">{conversation?.activity?.label ?? "Thinking through the request…"}</span>
          </div>
        ) : null}
        {failure ? (
          <div className="chat-error" role="alert">
            <span><b>The Scribe could not reply.</b> {failure}</span>
            <button type="button" className="link" onClick={() => conversation && dismissFailure(conversation.id)}>Dismiss</button>
          </div>
        ) : null}
      </div>

      {stopped ? (
        <div className="chat-sandbox small">
          <span className={`nav-dot ${sandbox.data?.state === "stopped" ? "" : "absent"}`} />
          {sandbox.data?.imageAvailable === false
            ? <span>The sandbox image is not built yet (<code>npm run sandbox:build</code>), so the Scribe cannot use the workspace.</span>
            : <span>The sandbox is not running, so the Scribe cannot use the workspace.</span>}
          {sandbox.data?.imageAvailable !== false ? (
            <button
              type="button"
              className="link"
              onClick={(event) => {
                const button = event.currentTarget;
                button.disabled = true;
                api(`/projects/${projectId}/sandbox/start`, { method: "POST" })
                  .then(() => (invalidate(keys.sandbox(projectId)), invalidate(keys.workspace(projectId)), flash("The sandbox is running", "ok")), flashFailure)
                  .finally(() => { button.disabled = false; });
              }}
            >
              Start it
            </button>
          ) : null}
        </div>
      ) : null}

      <form className="chat-composer" onSubmit={(event) => (event.preventDefault(), send())}>
        <SmartTextarea
          textareaRef={input}
          rows={1}
          value={text}
          onValue={write}
          placeholder={running ? "The Scribe is replying. Write your next message…" : list.length ? "Reply to the Scribe…" : isOwner ? "Ask about the forum, or for something built in the sandbox…" : "Ask about the forum, a source, or a draft…"}
          aria-label="Message the Scribe"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="chat-composer-foot">
          {isOwner ? (
            <Popover
              label="The Scribe's model"
              align="left"
              className="above model-popover"
              button={({ open, toggle }) => (
                <button type="button" className={`model-chip ${ready ? "" : "unset"} ${open ? "on" : ""}`} aria-expanded={open} onClick={toggle} title="The model this reply is asked with">
                  {ready ? <>{model.provider}/<b>{model.model}</b>{model.thinkingLevel !== "off" ? ` · ${model.thinkingLevel}` : ""}</> : "Choose a model"}
                  {icons.chevron}
                </button>
              )}
            >
              {() => <ModelForm model={model} agents={agents} />}
            </Popover>
          ) : (
            <span className={`model-chip ${ready ? "" : "unset"}`} title="The owner-configured model used for member Scribes">
              {ready ? <>{model.provider}/<b>{model.model}</b>{model.thinkingLevel !== "off" ? ` · ${model.thinkingLevel}` : ""}</> : "Scribe not configured"}
            </span>
          )}
          <span className="muted small chat-hint">Enter sends · Shift+Enter for a new line</span>
          <button type="submit" className="primary" disabled={!text.trim() || running} title={running ? "The Scribe is still replying" : "Send (Enter)"}>Send</button>
        </div>
      </form>
    </div>
  );
}

/** Until a model has been chosen for the Scribe, the first configured agent's is offered. */
export function useScribeModelDefault(agents: AgentRecord[] | undefined, enabled = true): void {
  const model = scribeModel.use();
  useEffect(() => {
    // A chosen provider with no model is the normal state between changing provider and choosing its model.
    // Default only a completely untouched selection, or this effect immediately undoes the provider change.
    if (!enabled || !scribeModelNeedsDefault(model)) return;
    const profile = agents?.find((agent) => agent.profile && !agent.disabledAt)?.profile;
    if (profile) setScribeModel({ provider: profile.provider, model: profile.model, thinkingLevel: profile.thinkingLevel });
  }, [agents, model, enabled]);
}

// ---------------------------------------------------------------------------------------------- the panel

export function ScribeChat() {
  const { projectId, isOwner } = useProject();
  const conversations = useConversations(projectId, true);
  const agents = useAgents(isOwner);
  const state = chat.use();
  const list = conversations.data;

  // A stored choice that no longer exists (another database, a different person) falls back to a new conversation.
  const stored = state.selected[projectId];
  const selected: number | "new" = stored === undefined
    ? list?.[0]?.id ?? "new"
    : stored !== "new" && list && !list.some((conversation) => conversation.id === stored) ? "new" : stored;
  const conversation = typeof selected === "number" ? list?.find((each) => each.id === selected) : undefined;

  useScribeModelDefault(agents.data, isOwner);

  // Looking at a conversation is reading it.
  useEffect(() => {
    if (typeof selected === "number" && state.unread[selected]) selectChat(projectId, selected);
  }, [selected, state.unread, projectId]);

  const unread = Object.values(state.unread).filter((project) => project === projectId).length;
  return (
    <PanelFrame
      label="The Scribe"
      title={<>{icons.quill} Scribe</>}
      onClose={hideScribe}
      sub={
        <Popover
          label="Conversations"
          align="left"
          className="chat-switcher"
          button={({ open, toggle }) => (
            <button type="button" className={`chat-title ${open ? "on" : ""}`} aria-expanded={open} onClick={toggle} title="Your conversations with the Scribe">
              <span>{titleOf(conversation)}</span>
              {unread ? <span className="count-badge">{unread}</span> : null}
              {icons.chevron}
            </button>
          )}
        >
          {(close) => (
            <>
              <button type="button" className="chat-new" onClick={() => (selectChat(projectId, "new", null), close())}>{icons.plus} New conversation</button>
              {list?.length ? (
                <ul className="chat-list">
                  {list.map((each) => (
                    <li key={each.id}>
                      <button type="button" className={each.id === selected ? "current" : ""} onClick={() => (selectChat(projectId, each.id), close())}>
                        <span className="chat-list-title">
                          {state.unread[each.id] ? <i className="mark-dot unread inline" /> : null}
                          {titleOf(each)}
                        </span>
                        <span className="chat-list-meta">
                          {each.status === "running" || state.pending[each.id] ? <><Dots /> replying · </> : null}
                          <Time at={each.updatedAt} /> · {plural(each.messageCount, "message")}
                          {each.anchor ? <> · <KindIcon kind={each.anchor.slice(0, each.anchor.indexOf(":"))} /> {each.anchor}</> : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="muted small chat-list-empty">No conversations yet.</p>}
            </>
          )}
        </Popover>
      }
      actions={
        <button type="button" className="icon-button" title="New conversation" aria-label="New conversation" onClick={() => selectChat(projectId, "new", null)}>{icons.plus}</button>
      }
    >
      {list === undefined && conversations.loading
        ? <div className="chat"><div className="chat-log" /></div>
        : <ConversationView key={`${projectId}:${selected}`} selected={selected} conversation={conversation} agents={agents.data ?? []} />}
      {conversations.error && !list ? <p className="chat-error">{describeError(conversations.error)}</p> : null}
    </PanelFrame>
  );
}
