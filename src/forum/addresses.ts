import type { PoolClient } from "pg";

export const addressPrefixes = [
  "thread", "post", "source", "excerpt", "result",
  "question", "claim", "evidence", "proposal", "rel",
] as const;

export type AddressPrefix = typeof addressPrefixes[number];

export interface ParsedAddress {
  prefix: AddressPrefix;
  localId: number;
  fragment?: string;
}

export interface AddressPreview {
  address: string;
  kind: AddressPrefix;
  heading: string;
  content: string | null;
  truncated: boolean;
  source?: {
    address: string;
    title: string;
    locator: string | null;
  };
}

const addressPattern = /^(thread|post|source|excerpt|result|question|claim|evidence|proposal|rel):([1-9]\d*)(?:#([a-z][a-z0-9_-]{0,63}))?$/;
const discourseKinds: Partial<Record<AddressPrefix, string>> = {
  question: "question",
  claim: "claim",
  evidence: "evidence",
  proposal: "proposal",
  rel: "relation",
};
const tables: Partial<Record<AddressPrefix, string>> = {
  thread: "thread",
  post: "post",
  source: "source",
  excerpt: "excerpt",
  result: "result",
  question: "discourse_object",
  claim: "discourse_object",
  evidence: "discourse_object",
  proposal: "discourse_object",
  rel: "discourse_object",
};

export function parseAddress(value: string): ParsedAddress | null {
  const match = addressPattern.exec(value);
  if (!match) return null;
  const localId = Number(match[2]);
  if (!Number.isSafeInteger(localId)) return null;
  const prefix = match[1] as AddressPrefix;
  const fragment = match[3];
  if (fragment && prefix !== "result") return null;
  return { prefix, localId, ...(fragment ? { fragment } : {}) };
}

export function formatAddress(prefix: AddressPrefix, localId: number, fragment?: string): string {
  if (!Number.isSafeInteger(localId) || localId < 1) throw new Error("invalid_local_id");
  if (fragment && prefix !== "result") throw new Error("fragment_requires_result");
  if (fragment && !/^[a-z][a-z0-9_-]{0,63}$/.test(fragment)) throw new Error("invalid_fragment");
  return `${prefix}:${localId}${fragment ? `#${fragment}` : ""}`;
}

export function extractReferences(text: string | null | undefined): string[] {
  if (!text) return [];
  const references = new Set<string>();
  for (const match of text.matchAll(/\[\[([^\[\]]+)\]\]/g)) {
    const parsed = parseAddress(match[1]);
    if (!parsed) throw new Error(`invalid_reference:${match[1]}`);
    references.add(formatAddress(parsed.prefix, parsed.localId, parsed.fragment));
  }
  return [...references];
}

export function replaceLocalReferences(text: string, created: ReadonlyMap<string, string>): string {
  return text.replace(/\[\[new:([a-z][a-z0-9_-]{0,31})\]\]/g, (_match, key: string) => {
    const address = created.get(key);
    if (!address) throw new Error(`unknown_local_reference:${key}`);
    return `[[${address}]]`;
  });
}

export function replaceLocalAddress(value: string, created: ReadonlyMap<string, string>): string {
  if (!value.startsWith("new:")) return value;
  const address = created.get(value.slice(4));
  if (!address) throw new Error(`unknown_local_reference:${value.slice(4)}`);
  return address;
}

export async function reserveProjectAddresses(
  client: PoolClient,
  projectId: number,
  count: number,
): Promise<number> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("invalid_address_count");
  const result = await client.query<{ first_id: number }>(
    `update project
        set next_address_local_id = next_address_local_id + $2
      where row_id = $1
    returning next_address_local_id - $2 as first_id`,
    [projectId, count],
  );
  const first = result.rows[0]?.first_id;
  if (!first) throw new Error("project_not_found");
  return first;
}

export async function addressExists(
  client: PoolClient,
  projectId: number,
  address: string,
): Promise<boolean> {
  const parsed = parseAddress(address);
  if (!parsed) return false;
  if (parsed.fragment) {
    if (parsed.prefix !== "result") return false;
    const result = await client.query(
      `select 1 from result where project_id = $1 and local_id = $2 and outputs ? $3`,
      [projectId, parsed.localId, parsed.fragment],
    );
    return Boolean(result.rows[0]);
  }
  const table = tables[parsed.prefix];
  if (!table) return false;
  const kind = discourseKinds[parsed.prefix];
  const result = kind
    ? await client.query(`select 1 from ${table} where project_id = $1 and local_id = $2 and kind = $3`, [projectId, parsed.localId, kind])
    : await client.query(`select 1 from ${table} where project_id = $1 and local_id = $2`, [projectId, parsed.localId]);
  return Boolean(result.rows[0]);
}

export async function requireProjectAddresses(
  client: PoolClient,
  projectId: number,
  addresses: Iterable<string>,
  created: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const address of new Set(addresses)) {
    if (created.has(address)) continue;
    if (!await addressExists(client, projectId, address)) throw new Error(`address_not_found:${address}`);
  }
}

export async function resolveAddress(
  client: PoolClient,
  projectId: number,
  address: string,
): Promise<Record<string, unknown> | null> {
  const parsed = parseAddress(address);
  if (!parsed) return null;
  if (parsed.fragment) {
    if (parsed.prefix !== "result") return null;
    const result = await client.query(
      `select local_id, submission_id, thread_id, outputs -> $3 as value, created_at
         from result where project_id = $1 and local_id = $2 and outputs ? $3`,
      [projectId, parsed.localId, parsed.fragment],
    );
    return result.rows[0] ? { ...result.rows[0], key: parsed.fragment } : null;
  }
  const table = tables[parsed.prefix];
  if (!table) return null;
  const kind = discourseKinds[parsed.prefix];
  const result = kind
    ? await client.query(`select * from ${table} where project_id = $1 and local_id = $2 and kind = $3`, [projectId, parsed.localId, kind])
    : await client.query(`select * from ${table} where project_id = $1 and local_id = $2`, [projectId, parsed.localId]);
  return result.rows[0] ?? null;
}

export interface AddressPlace {
  threadId: number | null;
  postId: number | null;
  postAddress: string | null;
}

function rowId(value: unknown): number | null {
  const id = Number(value);
  return value != null && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Where a resolved record is shown: its thread, and the post that is it or that introduced it. A thread or a result
 * has a thread and no post; a source has neither.
 */
export async function placeAddress(
  client: PoolClient,
  projectId: number,
  prefix: AddressPrefix,
  record: Record<string, unknown>,
): Promise<AddressPlace> {
  const nowhere = { threadId: null, postId: null, postAddress: null };
  if (prefix === "source") return nowhere;
  if (prefix === "thread") return { ...nowhere, threadId: rowId(record.row_id) };
  if (prefix === "result") return { ...nowhere, threadId: rowId(record.thread_id) };
  const postId = rowId(prefix === "post" ? record.row_id : record.born_in_post_id);
  if (!postId) return nowhere;
  const result = await client.query<{ threadId: number; localId: number }>(
    `select thread_id as "threadId", local_id as "localId" from post where project_id = $1 and row_id = $2`,
    [projectId, postId],
  );
  const post = result.rows[0];
  return post ? { threadId: post.threadId, postId, postAddress: formatAddress("post", post.localId) } : nowhere;
}

function bounded(value: string | null, maxCharacters: number): { content: string | null; truncated: boolean } {
  if (!value || value.length <= maxCharacters) return { content: value, truncated: false };
  return { content: `${value.slice(0, maxCharacters)}\n[preview truncated]`, truncated: true };
}

/** The shared, project-scoped representation used by browser tooltips and agent tools. */
export async function previewAddress(
  client: PoolClient,
  projectId: number,
  address: string,
  maxCharacters = 2_000,
): Promise<AddressPreview | null> {
  const parsed = parseAddress(address);
  if (!parsed) return null;
  const canonical = formatAddress(parsed.prefix, parsed.localId, parsed.fragment);

  if (parsed.prefix === "result") {
    const result = await client.query<{
      outputs: Record<string, unknown>;
      proposalLocalId: number | null;
      threadLocalId: number;
    }>(
      `select r.outputs, d.local_id as "proposalLocalId", t.local_id as "threadLocalId"
         from result r join thread t on t.row_id = r.thread_id
         left join discourse_object d on d.row_id = r.proposal_id
        where r.project_id = $1 and r.local_id = $2`,
      [projectId, parsed.localId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const value = parsed.fragment ? row.outputs[parsed.fragment] : row.outputs;
    if (parsed.fragment && !Object.prototype.hasOwnProperty.call(row.outputs, parsed.fragment)) return null;
    const text = JSON.stringify(value, null, 2) ?? "null";
    const content = bounded(text, maxCharacters);
    const target = row.proposalLocalId
      ? `proposal [[${formatAddress("proposal", row.proposalLocalId)}]]`
      : `thread [[${formatAddress("thread", row.threadLocalId)}]]`;
    return {
      address: canonical,
      kind: parsed.prefix,
      heading: parsed.fragment ? `${parsed.fragment} from result:${parsed.localId}` : `Result for ${target}`,
      ...content,
    };
  }

  if (parsed.fragment) return null;

  if (parsed.prefix === "thread") {
    const result = await client.query<{ title: string; tags: string[]; postCount: number }>(
      `select t.title, t.tags, count(p.row_id)::int as "postCount"
         from thread t left join post p on p.thread_id = t.row_id
        where t.project_id = $1 and t.local_id = $2
        group by t.row_id`,
      [projectId, parsed.localId],
    );
    const row = result.rows[0];
    return row ? {
      address: canonical,
      kind: parsed.prefix,
      heading: row.title,
      content: `${row.postCount} posts${row.tags.length ? ` · tags: ${row.tags.join(", ")}` : ""}`,
      truncated: false,
    } : null;
  }

  if (parsed.prefix === "post") {
    const result = await client.query<{ author: string; threadTitle: string; body: string }>(
      `select u.handle as author, t.title as "threadTitle", p.body
         from post p join forum_user u on u.row_id = p.author_user_id
         join thread t on t.row_id = p.thread_id
        where p.project_id = $1 and p.local_id = $2`,
      [projectId, parsed.localId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const content = bounded(row.body, maxCharacters);
    return { address: canonical, kind: parsed.prefix, heading: `@${row.author} in ${row.threadTitle}`, ...content };
  }

  if (parsed.prefix === "source") {
    const result = await client.query<{ title: string; authors: string[]; locator: string }>(
      `select title, authors, locator from source where project_id = $1 and local_id = $2`,
      [projectId, parsed.localId],
    );
    const row = result.rows[0];
    return row ? {
      address: canonical,
      kind: parsed.prefix,
      heading: row.title,
      content: `${row.authors.length ? `${row.authors.join(", ")} · ` : ""}${row.locator}`,
      truncated: false,
    } : null;
  }

  if (parsed.prefix === "excerpt") {
    const result = await client.query<{ title: string; sourceLocalId: number; locator: string | null; content: string | null }>(
      `select s.title, s.local_id as "sourceLocalId", e.locator, e.content
         from excerpt e join source s on s.row_id = e.source_id
        where e.project_id = $1 and e.local_id = $2`,
      [projectId, parsed.localId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const content = bounded(row.content, maxCharacters);
    return {
      address: canonical,
      kind: parsed.prefix,
      heading: `Excerpt from [[${formatAddress("source", row.sourceLocalId)}]] ${row.title}${row.locator ? ` (${row.locator})` : ""}`,
      source: {
        address: formatAddress("source", row.sourceLocalId),
        title: row.title,
        locator: row.locator,
      },
      ...content,
    };
  }

  const kind = discourseKinds[parsed.prefix];
  if (kind) {
    const result = await client.query<{
      label: string | null;
      body: string | null;
      expectedOutputs: Record<string, unknown> | null;
      relationType: string | null;
      subjects: string[] | null;
      objects: string[] | null;
    }>(
      `select label, body, expected_outputs as "expectedOutputs",
              relation_type as "relationType", subjects, objects
         from discourse_object
        where project_id = $1 and local_id = $2 and kind = $3`,
      [projectId, parsed.localId, kind],
    );
    const row = result.rows[0];
    if (!row) return null;
    let text = row.relationType
      ? `${row.subjects?.map((value) => `[[${value}]]`).join(", ")} ${row.relationType} ${row.objects?.map((value) => `[[${value}]]`).join(", ")}`
      : row.body;
    if (kind === "proposal" && row.expectedOutputs && Object.keys(row.expectedOutputs).length) {
      const expected = `Expected result outputs (use these as the top-level output keys):\n${JSON.stringify(row.expectedOutputs, null, 2)}`;
      text = text ? `${text}\n\n${expected}` : expected;
    }
    const content = bounded(text, maxCharacters);
    return { address: canonical, kind: parsed.prefix, heading: row.label || kind, ...content };
  }

  return null;
}
