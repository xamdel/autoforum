import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";

import type { AppDatabase } from "../src/db.ts";
import { createMcpRoutes } from "../src/mcp.ts";

function fixture() {
  let credentialActive = true;
  let authenticationCount = 0;
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("from mcp_credential c")) {
        authenticationCount += 1;
        return { rows: credentialActive ? [{ credential_id: 4, id: 7, kind: "agent", handle: "outside", is_owner: false }] : [] };
      }
      if (sql.startsWith("update mcp_credential set last_used_at")) return { rows: [], rowCount: 1 };
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: null };
      if (sql.includes("select 1 from thread t join project_member")) return { rows: [] };
      if (sql.startsWith("select 1 from project_member")) {
        return { rows: values[0] === 1 && values[1] === 7 ? [{ exists: 1 }] : [] };
      }
      if (sql.includes("from project p") && sql.includes("join project_member")) {
        return { rows: [{ id: 1, publicId: "00000000-0000-4000-8000-000000000001", name: "One", createdAt: new Date(1) }] };
      }
      if (sql.includes("count(p.row_id)::int as \"postCount\"")) {
        return { rows: [{ id: 9, localId: 3, subforumId: 2, subforumName: "General", title: "Thread", tags: [], pinned: false, createdAt: new Date(2), createdBy: "bob", postCount: 2, lastPostAt: new Date(3) }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async connect() {
      return { query: pool.query.bind(pool), release() {} };
    },
  };
  const database = { pool } as unknown as AppDatabase;
  const app = new Hono();
  app.route("/mcp", createMcpRoutes(database));
  const appFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    return await app.fetch(request);
  };
  return {
    app,
    appFetch,
    authenticationCount: () => authenticationCount,
    revoke: () => { credentialActive = false; },
  };
}

test("MCP authenticates each request and exposes only the explicit tool set", async () => {
  const server = fixture();
  const unauthenticated = await server.app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
  });
  assert.equal(unauthenticated.status, 401);

  const transport = new StreamableHTTPClientTransport(new URL("http://autoforum.test/mcp"), {
    requestInit: { headers: { Authorization: "Bearer afmcp_test-token" } },
    fetch: server.appFetch,
  });
  const client = new Client({ name: "autoforum-test", version: "1" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "create_thread",
      "list_mentions",
      "list_projects",
      "list_subforums",
      "list_threads",
      "publish_post",
      "read_address",
      "read_source",
      "search_forum",
    ]);

    const projects = await client.callTool({ name: "list_projects", arguments: {} });
    assert.deepEqual(projects.structuredContent, {
      projects: [{ id: 1, publicId: "00000000-0000-4000-8000-000000000001", name: "One", createdAt: "1970-01-01T00:00:00.001Z" }],
    });

    const threads = await client.callTool({ name: "list_threads", arguments: { projectId: 1 } });
    assert.equal(threads.isError, undefined);
    assert.equal((threads.structuredContent as { threads: Array<{ address: string }> }).threads[0]?.address, "thread:3");

    const forbidden = await client.callTool({ name: "list_threads", arguments: { projectId: 2 } });
    const forbiddenResult = forbidden as { isError?: boolean; content: Array<{ type: string; text: string }> };
    assert.equal(forbiddenResult.isError, true);
    assert.match(forbiddenResult.content[0]?.text ?? "", /project_not_found/);

    const forbiddenPublish = await client.callTool({
      name: "publish_post",
      arguments: { projectId: 2, threadId: 99, body: "must not publish", excerpts: [], objects: [] },
    }) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    assert.equal(forbiddenPublish.isError, true);
    assert.match(forbiddenPublish.content[0]?.text ?? "", /thread_not_found/);

    const beforeRevocation = server.authenticationCount();
    server.revoke();
    await assert.rejects(client.listTools(), /401|Unauthorized|HTTP/i);
    assert.ok(server.authenticationCount() > beforeRevocation);
  } finally {
    await client.close();
  }
});
