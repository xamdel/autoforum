// The browser's view of the HTTP API: one fetch wrapper and the shapes the server returns.
// Nothing here decides what is permitted; the server does.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

let unauthorized: (() => void) | null = null;

/** Called once by the app shell: what to do when a session has ended underneath an open page. */
export function onUnauthorized(handler: () => void): void {
  unauthorized = handler;
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const response = await fetch(`/api${path}`, {
    ...rest,
    ...(json === undefined ? {} : { body: JSON.stringify(json), headers: { "content-type": "application/json", ...rest.headers } }),
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/auth/")) unauthorized?.();
    throw new ApiError(response.status, body.error ?? `request_failed_${response.status}`);
  }
  return body as T;
}

export const encodeAddress = (address: string) => encodeURIComponent(address);

// ---------------------------------------------------------------------------------------------- people and projects

export interface User {
  id: number;
  kind: "human" | "agent";
  handle: string;
  isOwner: boolean;
  disabledAt?: string | null;
  createdAt?: string;
}

export interface AgentRunnerStatus {
  paused: boolean;
}

export interface Project {
  id: number;
  publicId: string;
  name: string;
  defaultAgentTurnLimit: number;
  agentTurnLimit: number;
  agentTurnCount: number;
  scribeProvider: string | null;
  scribeModel: string | null;
  scribeThinkingLevel: ThinkingLevel;
  createdAt: string;
}

export interface Member {
  id: number;
  kind: "human" | "agent";
  handle: string;
  isOwner: boolean;
  joinedAt: string;
}

export interface BrowserSession {
  id: number;
  userId: number;
  handle: string;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}

export interface McpCredential {
  id: number;
  name: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------------------------- forum

export interface ThreadSummary {
  id: number;
  localId: number;
  address: string;
  subforumId: number;
  subforumName: string;
  title: string;
  tags: string[];
  pinned: boolean;
  createdAt: string;
  createdBy: string;
  postCount: number;
  lastPostAt: string | null;
}

export interface Subforum {
  id: number;
  name: string;
  description: string;
  createdAt: string;
  threadCount: number;
}

export type ThreadHead = Omit<ThreadSummary, "postCount" | "lastPostAt"> & {
  agentTurnLimit: number;
  agentTurnCount: number;
  pendingTurnCount: number;
};

export interface Post {
  id: number;
  localId: number;
  address: string;
  authorId: number;
  author: string;
  replyToPostId: number | null;
  replyToAddress: string | null;
  body: string;
  refs: string[];
  createdAt: string;
}

export type ObjectKind = "question" | "claim" | "evidence" | "proposal" | "relation";
export type RelationType = "supports" | "opposes" | "tests" | "implements";

export interface DiscourseObject {
  id: number;
  localId: number;
  address: string;
  kind: ObjectKind;
  label: string | null;
  body: string | null;
  expectedOutputs: Record<string, unknown> | null;
  bornInPostId: number;
  relationType: RelationType | null;
  subjects: string[] | null;
  objects: string[] | null;
  refs: string[];
  creator: string;
  createdAt: string;
}

export interface Excerpt {
  id: number;
  localId: number;
  address: string;
  content: string;
  locator: string | null;
  capturedFrom: string | null;
  bornInPostId: number;
  sourceLocalId: number;
  sourceTitle: string;
  sourceAddress: string;
  createdAt: string;
}

export interface ForumResult {
  id: number;
  localId: number;
  address: string;
  submissionId: string;
  outputs: Record<string, unknown>;
  proposalLocalId: number | null;
  proposalAddress: string | null;
  expectedOutputs: Record<string, unknown> | null;
  missingOutputs: string[];
  additionalOutputs: string[];
  createdAt: string;
}

export interface ThreadDetail {
  thread: ThreadHead;
  posts: Post[];
  objects: DiscourseObject[];
  excerpts: Excerpt[];
  results: ForumResult[];
}

interface PublishObjectBase {
  key: string;
  label?: string | null;
}

export type PublishObject =
  | (PublishObjectBase & { kind: "question" | "claim" | "evidence"; body: string })
  | (PublishObjectBase & { kind: "proposal"; body: string; expectedOutputs?: Record<string, unknown> | null })
  | (PublishObjectBase & {
      kind: "relation";
      body?: string | null;
      relationType: RelationType;
      subjects: string[];
      objects: string[];
    });

export interface PublishExcerpt {
  key: string;
  source: string;
  content: string;
  locator?: string | null;
}

export interface PublishInput {
  body: string;
  replyTo?: string | null;
  excerpts: PublishExcerpt[];
  objects: PublishObject[];
}

export interface AddressPreview {
  address: string;
  kind: string;
  heading: string;
  content: string | null;
  truncated: boolean;
}

export interface SearchHit {
  kind: string;
  localId: number;
  address: string;
  heading: string | null;
  snippet: string | null;
  createdAt: string;
}

export interface Backlink {
  kind: string;
  localId: number;
  address: string;
  body: string | null;
  label?: string | null;
  author?: string;
  threadId?: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------------------------- library

export interface Source {
  id: number;
  localId: number;
  address: string;
  locator: string;
  title: string;
  authors: string[];
  tags: string[];
  uploaded: boolean;
  excerptCount: number;
  discussionCount: number;
  addedBy?: string;
  createdAt: string;
}

export interface SourceExcerpt {
  localId: number;
  address: string;
  content: string;
  locator: string | null;
  capturedFrom: string | null;
  createdAt: string;
}

export interface SourceText {
  finalUrl: string;
  contentType: string;
  text: string;
  truncated?: boolean;
}

// ---------------------------------------------------------------------------------------------- agents and the Scribe

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentProfile {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
}

export interface AgentRecord {
  userId: number;
  handle: string;
  profile: AgentProfile | null;
  disabledAt: string | null;
}

export type TurnStatus = "pending" | "queued" | "running" | "completed" | "failed" | "stopped";

export interface AgentTurn {
  id: number;
  status: TurnStatus;
  agent: string;
  requestedBy: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  usage: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens" | "reasoning", number>> | null;
  reportedCost: number | null;
  error: string | null;
  stopRequestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  triggerLocalId: number;
  outputLocalId: number | null;
}

export interface Conversation {
  id: number;
  anchor: string | null;
  status: "idle" | "running";
  activity: { label: string; updatedAt: string } | null;
  messageCount: number;
  preview: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "system";
  body: string;
  refs: string[];
  createdAt: string;
}

export interface ChatgptAccess {
  signedIn: boolean;
  planUsage: boolean;
  email: string | null;
  registered: boolean;
  accessExpiresAt: string | null;
  models: string[];
}

export interface ClaudeCodeAccess {
  signedIn: boolean;
  email: string | null;
  subscription: string | null;
  error: string | null;
}

export interface ModelApiKeyProvider {
  id: string;
  name: string;
  authName: string;
  configured: boolean;
  source: "stored" | "environment" | "other" | null;
  sourceLabel: string | null;
  sandboxService: Omit<ServiceAccessStatus, "grantedUntil" | "credentialSource"> | null;
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
}

// ---------------------------------------------------------------------------------------------- workspace

export interface SandboxStatus {
  state: "absent" | "stopped" | "running";
  imageAvailable: boolean;
  applicationAvailable: boolean;
  createdAt?: string;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  kind: "regular" | "directory" | "symlink" | "special";
  size: number | null;
}

export interface WorkspaceView {
  path: string;
  name: string;
  size: number | null;
  kind: "markdown" | "html";
}

export interface WorkspaceFile {
  path: string;
  size: number;
  sha256: string;
  encoding: "utf8" | "base64";
  content: string;
}

export interface ResetPreview {
  state: "absent" | "stopped" | "running";
  dirty: string[];
  commits: string[];
}

export interface ServiceAccessStatus {
  name: string;
  upstream: string;
  baseUrlEnv: string;
  credentialEnv: string;
  authHeader: string;
  authPrefix: string;
  grantedUntil: string | null;
  credentialSource?: { type: "model-api-key"; provider: string };
}
