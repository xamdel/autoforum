import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { Hono } from "hono";

import type { AppDatabase } from "../src/db.ts";
import { createPreviewFeature, previewPolicyHeaders, stripPreviewCredentials } from "../src/workspace/preview.ts";
import { PREVIEW_RELAY_HEADER, workspaceShellIsAvailable } from "../src/sandbox/lifecycle.ts";

test("preview policy isolates embedded applications without disabling their own code", () => {
  const headers = previewPolicyHeaders("http://app.autoforum.localhost:5173");
  assert.match(headers["content-security-policy"]!, /connect-src 'self'/);
  assert.match(headers["content-security-policy"]!, /frame-ancestors http:\/\/app\.autoforum\.localhost:5173/);
  assert.match(headers["content-security-policy"]!, /sandbox allow-scripts allow-same-origin allow-downloads/);
  assert.match(headers["content-security-policy"]!, /script-src 'self' 'unsafe-inline'/);
  assert.doesNotMatch(headers["content-security-policy"]!, /unsafe-eval/);
  assert.equal(
    stripPreviewCredentials("autoforum_session=forum; autoforum_preview_dev=viewer; app_state=kept"),
    "app_state=kept",
  );
});

test("the workspace shell is available only while its HTTP server answers", async () => {
  let receivedToken = "";
  const server = http.createServer((request, response) => {
    receivedToken = String(request.headers[PREVIEW_RELAY_HEADER] ?? "");
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const target = { host: "127.0.0.1", port: address.port, relayToken: "probe-token" };
  try {
    assert.equal(await workspaceShellIsAvailable(target), true);
    assert.equal(receivedToken, "probe-token");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  assert.equal(await workspaceShellIsAvailable(target, 100), false);
});

test("preview launch and proxy keep forum authority out of the sandbox", async () => {
  const previousAppOrigin = process.env.APP_ORIGIN;
  const previousPreviewOrigin = process.env.PREVIEW_BASE_ORIGIN;
  process.env.APP_ORIGIN = "http://app.autoforum.localhost:5173";
  process.env.PREVIEW_BASE_ORIGIN = "http://preview.autoforum.localhost:3000";
  let authorized = true;
  const upstreamRequests: Array<{ authorization: string; cookie: string; body: string; relayToken: string }> = [];
  const upstreamSockets: object[] = [];
  const upstream = http.createServer(async (request, response) => {
    upstreamSockets.push(request.socket);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    upstreamRequests.push({
      authorization: request.headers.authorization ?? "",
      cookie: request.headers.cookie ?? "",
      body: Buffer.concat(chunks).toString("utf8"),
      relayToken: String(request.headers[PREVIEW_RELAY_HEADER] ?? ""),
    });
    response.setHeader("content-type", "application/json");
    response.setHeader("content-security-policy", "default-src * 'unsafe-eval'");
    response.setHeader("set-cookie", [
      "app_state=kept; Path=/; HttpOnly",
      "cross_viewer=blocked; Domain=.preview.autoforum.localhost; Path=/",
    ]);
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert(address && typeof address !== "string");
  let resolvedTargets = 0;

  const database = {
    pool: {
      async query(sql: string) {
        if (sql.includes("from browser_session")) {
          return { rows: authorized ? [{ id: 4, kind: "human", handle: "member", is_owner: false }] : [] };
        }
        if (sql.includes("update browser_session")) return { rows: [] };
        if (sql.includes("from project p join project_member")) {
          return { rows: authorized ? [{ projectId: 7, publicId: "00000000-0000-4000-8000-000000000007" }] : [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    },
  } as unknown as AppDatabase;
  const feature = createPreviewFeature(database, async () => {
    resolvedTargets += 1;
    return { host: "127.0.0.1", port: address.port, relayToken: "unit-relay-token" };
  });
  const app = new Hono();
  app.use("*", feature.middleware);
  app.route("/api", feature.routes);

  try {
    const launchResponse = await app.request("http://app.autoforum.localhost/api/projects/7/preview/launch", {
      method: "POST",
      headers: {
        cookie: "autoforum_session=forum-secret",
        origin: "http://app.autoforum.localhost:5173",
      },
    });
    assert.equal(launchResponse.status, 200);
    const launch = await launchResponse.json() as { url: string };
    assert.match(launch.url, /^http:\/\/[a-f0-9]+\.preview\.autoforum\.localhost:3000\/\.autoforum\/launch\?code=/);

    const exchange = await app.request(launch.url, { redirect: "manual" });
    assert.equal(exchange.status, 302);
    assert.equal(exchange.headers.get("location"), "/");
    const setCookie = exchange.headers.get("set-cookie") ?? "";
    const viewerCookie = /autoforum_preview_dev=([^;]+)/.exec(setCookie)?.[1];
    assert(viewerCookie);

    const viewer = new URL(launch.url).origin;
    const proxied = await app.request(`${viewer}/api/echo`, {
      method: "POST",
      headers: {
        authorization: "Bearer must-not-reach-sandbox",
        cookie: `autoforum_preview_dev=${viewerCookie}; app_state=kept`,
        origin: viewer,
        [PREVIEW_RELAY_HEADER]: "browser-supplied-token",
      },
      body: "temperature=21",
    });
    assert.equal(proxied.status, 200);
    assert.deepEqual(await proxied.json(), { ok: true });
    assert.deepEqual(upstreamRequests[0], {
      authorization: "",
      cookie: "app_state=kept",
      body: "temperature=21",
      relayToken: "unit-relay-token",
    });
    assert.match(proxied.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.doesNotMatch(proxied.headers.get("content-security-policy") ?? "", /unsafe-eval/);
    assert.match(proxied.headers.get("set-cookie") ?? "", /app_state=kept/);
    assert.doesNotMatch(proxied.headers.get("set-cookie") ?? "", /cross_viewer/);

    const second = await app.request(`${viewer}/api/second`, {
      headers: { cookie: `autoforum_preview_dev=${viewerCookie}` },
    });
    assert.equal(second.status, 200);
    assert.notEqual(upstreamSockets[0], upstreamSockets[1], "each relayed request must use a fresh authenticated connection");

    const beforeForeignRequest = upstreamRequests.length;
    const foreign = await app.request(`${viewer}/api/echo`, {
      method: "POST",
      headers: { cookie: `autoforum_preview_dev=${viewerCookie}`, origin: "https://attacker.example" },
      body: "blocked",
    });
    assert.equal(foreign.status, 403);
    assert.equal(upstreamRequests.length, beforeForeignRequest);

    authorized = false;
    const revoked = await app.request(`${viewer}/`, {
      headers: { cookie: `autoforum_preview_dev=${viewerCookie}` },
    });
    assert.equal(revoked.status, 401);

    const reused = await app.request(launch.url, { redirect: "manual" });
    assert.equal(reused.status, 401);

    assert.equal(resolvedTargets, 1);
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    if (previousAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousAppOrigin;
    if (previousPreviewOrigin === undefined) delete process.env.PREVIEW_BASE_ORIGIN;
    else process.env.PREVIEW_BASE_ORIGIN = previousPreviewOrigin;
  }
});
