import type { PoolClient } from "pg";

import type { AppDatabase } from "../db.ts";
import { formatAddress, previewAddress, type AddressPrefix } from "../forum/addresses.ts";

const POST_SELECTION_BUDGET = 32_000;
const POST_BODY_LIMIT = 8_000;
const ATTACHMENT_BUDGET_PER_POST = 5_000;
const REFERENCED_RECORDS_BUDGET = 16_000;
const OUTLINE_LIMIT = 250;

interface ContextPost {
  id: number;
  localId: number;
  author: string;
  replyToPostId: number | null;
  body: string;
  refs: string[];
  createdAt: Date;
}

interface ContextObject {
  id: number;
  localId: number;
  bornInPostId: number;
  kind: string;
  label: string | null;
  body: string | null;
  expectedOutputs: Record<string, unknown> | null;
  relationType: string | null;
  subjects: string[] | null;
  objects: string[] | null;
  refs: string[];
}

interface ContextExcerpt {
  id: number;
  localId: number;
  bornInPostId: number;
  content: string | null;
  locator: string | null;
  sourceLocalId: number;
  sourceTitle: string;
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated]`;
}

/** Required posts plus as many newest posts as fit, returned in chronological order. */
export function selectContextPosts(
  posts: readonly ContextPost[],
  triggerPostId: number,
  budget = POST_SELECTION_BUDGET,
): ContextPost[] {
  const trigger = posts.find((post) => post.id === triggerPostId);
  if (!trigger) throw new Error("trigger_post_not_found");
  const required = new Set<number>([posts[0]?.id, trigger.id, trigger.replyToPostId].filter((value): value is number => Boolean(value)));
  const selected = new Set(required);
  let used = posts
    .filter((post) => required.has(post.id))
    .reduce((sum, post) => sum + Math.min(post.body.length, POST_BODY_LIMIT) + 200, 0);

  for (let index = posts.length - 1; index >= 0; index -= 1) {
    const post = posts[index];
    if (!post || selected.has(post.id)) continue;
    const cost = Math.min(post.body.length, POST_BODY_LIMIT) + 200;
    if (used + cost > budget) continue;
    selected.add(post.id);
    used += cost;
  }
  return posts.filter((post) => selected.has(post.id));
}

function postOutline(posts: readonly ContextPost[], included: ReadonlySet<number>): string[] {
  const visible = posts.length <= OUTLINE_LIMIT
    ? posts
    : [...posts.slice(0, 1), ...posts.slice(-(OUTLINE_LIMIT - 1))];
  const lines = visible.map((post) => {
    const reply = post.replyToPostId
      ? posts.find((candidate) => candidate.id === post.replyToPostId)
      : null;
    return `- [[${formatAddress("post", post.localId)}]] @${post.author}${reply ? ` replies to [[${formatAddress("post", reply.localId)}]]` : ""}${included.has(post.id) ? " · expanded below" : ""}`;
  });
  if (visible.length < posts.length) lines.splice(1, 0, `- [${posts.length - visible.length} intermediate posts omitted from this outline]`);
  return lines;
}

function objectPrefix(kind: string): AddressPrefix {
  return kind === "relation" ? "rel" : kind as AddressPrefix;
}

function renderAttachmentBlock(objects: readonly ContextObject[], excerpts: readonly ContextExcerpt[]): string {
  const blocks: string[] = [];
  for (const object of objects) {
    const address = formatAddress(objectPrefix(object.kind), object.localId);
    const content = object.relationType
      ? `${object.subjects?.map((value) => `[[${value}]]`).join(", ")} ${object.relationType} ${object.objects?.map((value) => `[[${value}]]`).join(", ")}`
      : object.body;
    const expected = object.kind === "proposal" && object.expectedOutputs && Object.keys(object.expectedOutputs).length
      ? `Expected result outputs (use these as the top-level output keys):\n${JSON.stringify(object.expectedOutputs, null, 2)}`
      : null;
    const details = [content, expected].filter((value): value is string => Boolean(value)).join("\n\n");
    blocks.push(`  ${object.kind} [[${address}]]${object.label ? ` — ${object.label}` : ""}\n${details ? bounded(details, 4_000) : ""}`.trimEnd());
  }
  for (const excerpt of excerpts) {
    blocks.push(`  excerpt [[${formatAddress("excerpt", excerpt.localId)}]] from [[${formatAddress("source", excerpt.sourceLocalId)}]] ${excerpt.sourceTitle}${excerpt.locator ? ` (${excerpt.locator})` : ""}\n${bounded(excerpt.content ?? "[binary excerpt]", 4_000)}`);
  }
  const joined = blocks.join("\n\n");
  return joined.length <= ATTACHMENT_BUDGET_PER_POST
    ? joined
    : `${joined.slice(0, ATTACHMENT_BUDGET_PER_POST)}\n[additional attachment content truncated]`;
}

async function loadAttachments(client: PoolClient, projectId: number, postIds: number[]) {
  if (!postIds.length) return { objects: [] as ContextObject[], excerpts: [] as ContextExcerpt[] };
  const [objects, excerpts] = await Promise.all([
    client.query<ContextObject>(
      `select row_id as id, local_id as "localId", born_in_post_id as "bornInPostId", kind, label, body,
              expected_outputs as "expectedOutputs",
              relation_type as "relationType", subjects, objects, refs
         from discourse_object where project_id = $1 and born_in_post_id = any($2::bigint[])
        order by local_id`,
      [projectId, postIds],
    ),
    client.query<ContextExcerpt>(
      `select e.row_id as id, e.local_id as "localId", e.born_in_post_id as "bornInPostId", e.content, e.locator,
              s.local_id as "sourceLocalId", s.title as "sourceTitle"
         from excerpt e join source s on s.row_id = e.source_id
        where e.project_id = $1 and e.born_in_post_id = any($2::bigint[])
        order by e.local_id`,
      [projectId, postIds],
    ),
  ]);
  return { objects: objects.rows, excerpts: excerpts.rows };
}

/** Builds a turn's deterministic, read-only forum context from current durable records. */
export async function buildAgentContext(
  database: AppDatabase,
  projectId: number,
  triggerPostId: number,
  currentAgentUserId?: number,
): Promise<string> {
  const client = await database.pool.connect();
  try {
    const triggerResult = await client.query<{ threadId: number; title: string; subforum: string; tags: string[] }>(
      `select p.thread_id as "threadId", t.title, s.name as subforum, t.tags
         from post p join thread t on t.row_id = p.thread_id
         join subforum s on s.row_id = t.subforum_id
        where p.project_id = $1 and p.row_id = $2`,
      [projectId, triggerPostId],
    );
    const thread = triggerResult.rows[0];
    if (!thread) throw new Error("trigger_post_not_found");
    const postResult = await client.query<ContextPost>(
      `select p.row_id as id, p.local_id as "localId", u.handle as author,
              p.reply_to_post_id as "replyToPostId", p.body, p.refs, p.created_at as "createdAt"
         from post p join forum_user u on u.row_id = p.author_user_id
        where p.project_id = $1 and p.thread_id = $2
        order by p.local_id`,
      [projectId, thread.threadId],
    );
    const agentResult = await client.query<{ handle: string }>(
      `select u.handle
         from forum_user u join project_member m on m.user_id = u.row_id
        where m.project_id = $1 and u.kind = 'agent' and u.disabled_at is null
          and ($2::bigint is null or u.row_id <> $2)
          and u.agent_config is not null
        order by u.handle`,
      [projectId, currentAgentUserId ?? null],
    );
    const selected = selectContextPosts(postResult.rows, triggerPostId);
    const included = new Set(selected.map((post) => post.id));
    const attachments = await loadAttachments(client, projectId, selected.map((post) => post.id));
    const represented = new Set<string>();
    const directReferences = new Set<string>();
    const sections: string[] = [
      `# Forum context\n\nSubforum: ${thread.subforum}\nThread: ${thread.title}${thread.tags.length ? `\nTags: ${thread.tags.join(", ")}` : ""}\nAvailable agents: ${agentResult.rows.length ? agentResult.rows.map((agent) => `@${agent.handle}`).join(", ") : "none"}`,
      `## Thread outline\n\n${postOutline(postResult.rows, included).join("\n")}`,
    ];

    const postBlocks: string[] = [];
    for (const post of selected) {
      const address = formatAddress("post", post.localId);
      represented.add(address);
      post.refs.forEach((reference) => directReferences.add(reference));
      const reply = post.replyToPostId
        ? postResult.rows.find((candidate) => candidate.id === post.replyToPostId)
        : null;
      const postObjects = attachments.objects.filter((object) => object.bornInPostId === post.id);
      const postExcerpts = attachments.excerpts.filter((excerpt) => excerpt.bornInPostId === post.id);
      for (const object of postObjects) {
        represented.add(formatAddress(objectPrefix(object.kind), object.localId));
        object.refs.forEach((reference) => directReferences.add(reference));
      }
      for (const excerpt of postExcerpts) represented.add(formatAddress("excerpt", excerpt.localId));
      const attachmentBlock = renderAttachmentBlock(postObjects, postExcerpts);
      postBlocks.push(
        `### [[${address}]] @${post.author}${post.id === triggerPostId ? " · trigger post" : ""}${reply ? ` · replies to [[${formatAddress("post", reply.localId)}]]` : ""}\n\n${bounded(post.body, POST_BODY_LIMIT)}${attachmentBlock ? `\n\nIntroduced records:\n${attachmentBlock}` : ""}`,
      );
    }
    sections.push(`## Selected posts\n\n${postBlocks.join("\n\n")}`);

    const previews: string[] = [];
    let previewCharacters = 0;
    for (const address of directReferences) {
      if (represented.has(address)) continue;
      const preview = await previewAddress(client, projectId, address);
      if (!preview) continue;
      const rendered = `### [[${preview.address}]] ${preview.heading}\n\n${preview.content ?? "[no text content]"}`;
      if (previewCharacters + rendered.length > REFERENCED_RECORDS_BUDGET) {
        previews.push("[additional referenced records omitted by the fixed context budget]");
        break;
      }
      previews.push(rendered);
      previewCharacters += rendered.length;
      represented.add(address);
    }
    if (previews.length) sections.push(`## Referenced records\n\n${previews.join("\n\n")}`);

    return `${sections.join("\n\n")}\n`;
  } finally {
    client.release();
  }
}
