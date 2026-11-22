// Every read the pages make, with its cache key and how often it refreshes. Keys start with the project so a write can
// invalidate a whole area ("p3/ws" is everything about project 3's workspace).

import {
  api, encodeAddress,
  type AddressPreview, type AgentRecord, type AgentRunnerStatus, type AgentTurn, type Backlink, type BrowserSession, type ChatMessage,
  type ChatgptAccess, type ClaudeCodeAccess, type Conversation, type McpCredential, type Member, type ModelApiKeyProvider, type Project, type SandboxStatus, type SearchHit, type Source,
  type ModelCatalogEntry, type SourceExcerpt, type Subforum, type ThreadDetail, type ThreadSummary, type User, type WorkspaceEntry, type WorkspaceFile,
  type ServiceAccessStatus,
} from "../lib/api.ts";
import { useQuery } from "../lib/query.ts";

export const keys = {
  projects: "projects",
  users: "users",
  agents: (projectId: number) => `p${projectId}/agents`,
  agentRunner: "agent-runner",
  sessions: "sessions",
  chatgptAccess: "model-access/chatgpt",
  claudeCodeAccess: "model-access/claude-code",
  modelApiKeys: "model-access/api-keys",
  modelCatalog: (provider: string) => `model-access/models/${provider}`,
  credentials: (userId: number) => `credentials/${userId}`,
  project: (id: number) => `p${id}/`,
  members: (id: number) => `p${id}/members`,
  subforums: (id: number) => `p${id}/subforums`,
  threads: (id: number) => `p${id}/threads`,
  thread: (id: number, threadId: number) => `p${id}/thread/${threadId}`,
  threadsPrefix: (id: number) => `p${id}/thread`,
  sources: (id: number) => `p${id}/sources`,
  source: (id: number, sourceId: number) => `p${id}/source/${sourceId}`,
  turns: (id: number) => `p${id}/turns`,
  conversations: (id: number) => `p${id}/conversations`,
  messages: (id: number, conversationId: number) => `p${id}/messages/${conversationId}`,
  sandbox: (id: number) => `p${id}/sandbox`,
  workspace: (id: number) => `p${id}/ws`,
  tree: (id: number) => `p${id}/ws/tree`,
  file: (id: number, path: string) => `p${id}/ws/file/${path}`,
  usage: (id: number) => `p${id}/ws/usage`,
  serviceAccess: (id: number) => `p${id}/service-access`,
  preview: (id: number, address: string) => `p${id}/preview/${address}`,
  backlinks: (id: number, address: string) => `p${id}/backlinks/${address}`,
  search: (id: number, query: string) => `p${id}/search/${query}`,
};

export const isActiveTurn = (turn: AgentTurn) => turn.status === "queued" || turn.status === "running";

export const useProjects = () => useQuery(keys.projects, () => api<{ projects: Project[] }>("/projects").then((result) => result.projects));

export const useMembers = (id: number | null) =>
  useQuery(id ? keys.members(id) : null, () => api<{ members: Member[] }>(`/projects/${id}/members`).then((result) => result.members));

export const useSubforums = (id: number) =>
  useQuery(keys.subforums(id), () => api<{ subforums: Subforum[] }>(`/projects/${id}/subforums`).then((result) => result.subforums));

export const useThreads = (id: number) =>
  useQuery(keys.threads(id), () => api<{ threads: ThreadSummary[] }>(`/projects/${id}/threads`).then((result) => result.threads), { every: 45_000 });

/** One thread with everything attached to it. Others post here too, so it refreshes quietly while open. */
export const useThread = (id: number, threadId: number | null) =>
  useQuery(threadId ? keys.thread(id, threadId) : null, () => api<ThreadDetail>(`/projects/${id}/threads/${threadId}`), { every: 15_000 });

export const useSources = (id: number) =>
  useQuery(keys.sources(id), () => api<{ sources: Source[] }>(`/projects/${id}/sources`).then((result) => result.sources));

export const useSource = (id: number, sourceId: number) =>
  useQuery(keys.source(id, sourceId), () => api<{ source: Source; excerpts: SourceExcerpt[] }>(`/projects/${id}/sources/${sourceId}`));

/** The project's recent agent turns. Fast while any is queued or running, slow otherwise. */
export const useTurns = (id: number, enabled: boolean) =>
  useQuery(enabled ? keys.turns(id) : null, () => api<{ turns: AgentTurn[] }>(`/projects/${id}/agent-turns`).then((result) => result.turns), {
    every: (turns) => (turns?.some(isActiveTurn) ? 2_000 : 30_000),
  });

/** The person's private Scribe conversations. Watched closely only while one is replying. */
export const useConversations = (id: number, enabled: boolean) =>
  useQuery(enabled ? keys.conversations(id) : null, () => api<{ conversations: Conversation[] }>(`/projects/${id}/conversations`).then((result) => result.conversations), {
    every: (list) => (list?.some((conversation) => conversation.status === "running") ? 500 : null),
  });

export const useMessages = (id: number, conversationId: number | null) =>
  useQuery(conversationId ? keys.messages(id, conversationId) : null, () =>
    api<{ conversation: Conversation; messages: ChatMessage[] }>(`/projects/${id}/conversations/${conversationId}/messages`).then((result) => result.messages));

/** `watch`: keep asking (the Workspace page is open, or the Scribe is working). Otherwise it is read once. */
export const useSandbox = (id: number, enabled: boolean, watch = false) =>
  useQuery(enabled ? keys.sandbox(id) : null, () => api<SandboxStatus>(`/projects/${id}/sandbox`), { every: watch ? 12_000 : null });

export const useTree = (id: number, enabled: boolean, every: number | null = null) =>
  useQuery(enabled ? keys.tree(id) : null, () => api<{ entries: WorkspaceEntry[] }>(`/projects/${id}/workspace/tree`).then((result) => result.entries), { every });

export const useFile = (id: number, path: string | null, every: number | null = null) =>
  useQuery(path ? keys.file(id, path) : null, () => api<WorkspaceFile>(`/projects/${id}/workspace/file?path=${encodeURIComponent(path ?? "")}`), { every });

export const useUsage = (id: number, enabled: boolean) =>
  useQuery(enabled ? keys.usage(id) : null, () => api<{ files: number; bytes: number }>(`/projects/${id}/workspace/usage`));

export const useServiceAccess = (id: number, enabled: boolean) =>
  useQuery(enabled ? keys.serviceAccess(id) : null, () => api<{ services: ServiceAccessStatus[] }>(`/projects/${id}/service-access`), {
    every: (result) => result?.services.some((service) => service.grantedUntil) ? 15_000 : null,
  });

export const usePreview = (id: number, address: string | null) =>
  useQuery(address ? keys.preview(id, address) : null, () =>
    api<{ preview: AddressPreview }>(`/projects/${id}/address-preview/${encodeAddress(address ?? "")}`).then((result) => result.preview));

export const useBacklinks = (id: number, address: string | null) =>
  useQuery(address ? keys.backlinks(id, address) : null, () =>
    api<{ backlinks: Backlink[] }>(`/projects/${id}/backlinks/${encodeAddress(address ?? "")}`).then((result) => result.backlinks));

export const useSearch = (id: number, query: string) =>
  useQuery(query ? keys.search(id, query) : null, () =>
    api<{ results: SearchHit[] }>(`/projects/${id}/search?q=${encodeURIComponent(query)}`).then((result) => result.results));

export const useAgents = (projectId: number, enabled: boolean) =>
  useQuery(enabled ? keys.agents(projectId) : null, () => api<{ agents: AgentRecord[] }>(`/agents?projectId=${projectId}`).then((result) => result.agents));

export const useAgentRunner = (enabled: boolean) =>
  useQuery(enabled ? keys.agentRunner : null, () => api<AgentRunnerStatus>("/agent-runner"));

export const useUsers = (enabled: boolean) =>
  useQuery(enabled ? keys.users : null, () => api<{ users: User[] }>("/users").then((result) => result.users));

export const useSessions = (enabled: boolean) =>
  useQuery(enabled ? keys.sessions : null, () => api<{ sessions: BrowserSession[] }>("/auth/sessions").then((result) => result.sessions));

export const useChatgptAccess = (enabled: boolean) =>
  useQuery(enabled ? keys.chatgptAccess : null, () => api<ChatgptAccess>("/model-access/chatgpt"));

export const useClaudeCodeAccess = (enabled: boolean) =>
  useQuery(enabled ? keys.claudeCodeAccess : null, () => api<ClaudeCodeAccess>("/model-access/claude-code"));

export const useModelApiKeys = (enabled: boolean) =>
  useQuery(enabled ? keys.modelApiKeys : null, () =>
    api<{ providers: ModelApiKeyProvider[] }>("/model-access/api-keys").then((result) => result.providers));

export const useModelCatalog = (provider: string, enabled = true) =>
  useQuery(enabled && provider ? keys.modelCatalog(provider) : null, () =>
    api<{ models: ModelCatalogEntry[] }>(`/model-access/models/${encodeURIComponent(provider)}`).then((result) => result.models));

export const useCredentials = (userId: number | null) =>
  useQuery(userId ? keys.credentials(userId) : null, () => api<{ credentials: McpCredential[] }>(`/users/${userId}/mcp-credentials`).then((result) => result.credentials));
