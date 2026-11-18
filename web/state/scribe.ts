// The Scribe's chat, outside any one page: which conversation is open in each project, the reply in flight, and the
// model it is asked with. A reply is one long request (the server answers when the Scribe has finished), so it is
// started here rather than in a component: it keeps running when you change page or close the dock, and the header
// can say that the Scribe is working or has replied.

import { api, type Conversation, type ThinkingLevel } from "../lib/api.ts";
import { describeError } from "../lib/format.ts";
import { invalidate, peekQuery, setQueryData } from "../lib/query.ts";
import { currentRoute } from "../lib/router.ts";
import { createStore, remembered } from "../lib/store.ts";
import { notify } from "../components/ui.tsx";
import { dock, dockContext, dockShowing, showScribe } from "./dock.ts";
import { keys } from "./queries.ts";

export interface ScribeModel {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

const MODEL_KEY = "autoforum.scribe.model";
const SELECTED_KEY = "autoforum.scribe.selected";

export const scribeModel = createStore<ScribeModel>({ provider: "", model: "", thinkingLevel: "off", ...remembered.read<Partial<ScribeModel>>(MODEL_KEY, {}) });

export function setScribeModel(next: ScribeModel): void {
  remembered.write(MODEL_KEY, next);
  scribeModel.set(next);
}

export const modelIsSet = (model: ScribeModel) => Boolean(model.provider.trim() && model.model.trim());
/** Only a completely untouched choice should inherit the first agent's model. */
export const scribeModelNeedsDefault = (model: ScribeModel) => !model.provider.trim() && !model.model.trim();

interface Pending {
  body: string;
  startedAt: number;
  /** How many messages the conversation showed when this was sent; the sent message shows until the list passes it. */
  base: number;
}

interface ChatState {
  /** The conversation open in each project; "new" is one that does not exist until its first message is sent. */
  selected: Record<number, number | "new">;
  /** What a project's unsent new conversation will be anchored to. */
  anchors: Record<number, string | null>;
  /** Text handed to the composer from elsewhere ("Ask the Scribe about this post"). */
  prefill: { projectId: number; text: string; nonce: number } | null;
  pending: Record<number, Pending>;
  failures: Record<number, string>;
  /** Conversations that got a reply while out of sight. */
  unread: Record<number, number>;
}

export const chat = createStore<ChatState>({
  selected: remembered.read<Record<number, number | "new">>(SELECTED_KEY, {}),
  anchors: {},
  prefill: null,
  pending: {},
  failures: {},
  unread: {},
});

const without = <T,>(record: Record<number, T>, id: number): Record<number, T> => {
  const { [id]: _removed, ...rest } = record;
  return rest;
};

export function selectChat(projectId: number, conversation: number | "new", anchor: string | null = null): void {
  chat.set((state) => {
    const selected = { ...state.selected, [projectId]: conversation };
    remembered.write(SELECTED_KEY, selected);
    return {
      ...state,
      selected,
      anchors: conversation === "new" ? { ...state.anchors, [projectId]: anchor } : state.anchors,
      unread: conversation === "new" ? state.unread : without(state.unread, conversation),
    };
  });
}

let prefillNonce = 0;

/**
 * Opens the Scribe with something to talk about. With an anchor, the latest conversation already anchored there is
 * continued (so a thread keeps one running conversation unless you start another); otherwise a new one is begun.
 */
export function askScribe(projectId: number, request: { anchor?: string | null; text?: string; fresh?: boolean } = {}): void {
  const anchor = request.anchor ?? null;
  const existing = anchor && !request.fresh
    ? (peekQuery<Conversation[]>(keys.conversations(projectId)) ?? []).find((conversation) => conversation.anchor === anchor)
    : undefined;
  if (existing) selectChat(projectId, existing.id);
  else if (anchor || request.fresh) selectChat(projectId, "new", anchor);
  if (request.text) chat.set((state) => ({ ...state, prefill: { projectId, text: request.text!, nonce: ++prefillNonce } }));
  showScribe();
}

export const takePrefill = () => chat.set((state) => (state.prefill ? { ...state, prefill: null } : state));
export const dismissFailure = (conversationId: number) => chat.set((state) => ({ ...state, failures: without(state.failures, conversationId) }));

/** Stops the server-side model run; aborting only the browser request would leave inference running. */
export async function stopScribe(projectId: number, conversationId: number): Promise<void> {
  await api(`/projects/${projectId}/conversations/${conversationId}/stop`, { method: "POST" });
}

function inSight(projectId: number, conversationId: number): boolean {
  return document.visibilityState === "visible"
    && Number(currentRoute().segments[0]) === projectId
    && dockShowing(dock.get(), dockContext()) === "scribe"
    && chat.get().selected[projectId] === conversationId;
}

/** Sends one message and waits, in the background, for the Scribe's reply. */
export async function sendToScribe(
  projectId: number,
  target: number | "new",
  body: string,
  shown: number,
  model: ScribeModel = scribeModel.get(),
): Promise<void> {
  let conversationId: number;
  try {
    if (target === "new") {
      const anchor = chat.get().anchors[projectId] ?? null;
      const created = await api<{ conversation: Conversation }>(`/projects/${projectId}/conversations`, { method: "POST", json: anchor ? { anchor } : {} });
      conversationId = created.conversation.id;
      setQueryData<Conversation[]>(keys.conversations(projectId), (list) => [created.conversation, ...(list ?? [])]);
      selectChat(projectId, conversationId);
    } else {
      conversationId = target;
    }
  } catch (error) {
    throw new Error(describeError(error));
  }

  chat.set((state) => ({
    ...state,
    pending: { ...state.pending, [conversationId]: { body, startedAt: Date.now(), base: target === "new" ? 0 : shown } },
    failures: without(state.failures, conversationId),
  }));
  const refresh = () => {
    invalidate(keys.messages(projectId, conversationId));
    invalidate(keys.conversations(projectId));
  };
  // The server stores the message and marks the conversation as running before the Scribe starts.
  window.setTimeout(refresh, 600);
  // When the request ends the conversation is idle again; say so at once rather than when the list is next read,
  // so the reply and "working" are never on screen together.
  const settle = () => setQueryData<Conversation[]>(keys.conversations(projectId), (list) =>
    list?.map((each) => (each.id === conversationId ? { ...each, status: "idle" as const } : each)));

  void api<{ stopped?: boolean }>(`/projects/${projectId}/conversations/${conversationId}/replies`, {
    method: "POST",
    json: { body, provider: model.provider.trim(), model: model.model.trim(), thinkingLevel: model.thinkingLevel },
  }).then(
    (result) => {
      settle();
      chat.set((state) => ({ ...state, pending: without(state.pending, conversationId) }));
      if (!result.stopped && !inSight(projectId, conversationId)) {
        chat.set((state) => ({ ...state, unread: { ...state.unread, [conversationId]: projectId } }));
        notify("The Scribe has replied.", { onClick: () => (selectChat(projectId, conversationId), showScribe()) });
      }
    },
    (error: unknown) => {
      settle();
      chat.set((state) => ({
        ...state,
        pending: without(state.pending, conversationId),
        failures: { ...state.failures, [conversationId]: describeError(error) },
      }));
    },
  ).finally(() => {
    refresh();
    // The Scribe may have written files, started an application, or produced results.
    invalidate(keys.workspace(projectId));
    invalidate(keys.sandbox(projectId));
    invalidate(keys.serviceAccess(projectId));
    invalidate(keys.threadsPrefix(projectId));
  });
}
