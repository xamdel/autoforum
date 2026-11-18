import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { configuredBrowserOrigins, setBrowserSessionCookie } from "../src/auth/browser.ts";
import { quickTunnelOrigin } from "../scripts/share.ts";

test("temporary sharing recognizes only the exact launcher-supplied browser origins", () => {
  assert.deepEqual(configuredBrowserOrigins({
    APP_ORIGIN: "http://app.autoforum.localhost:5173",
    AUTOFORUM_SHARE_ORIGIN: "https://small-demo.trycloudflare.com",
  }, "http://127.0.0.1:3000"), [
    "http://app.autoforum.localhost:5173",
    "https://small-demo.trycloudflare.com",
  ]);
});

test("the launcher extracts a Quick Tunnel origin from cloudflared output", () => {
  assert.equal(
    quickTunnelOrigin("INF Your quick Tunnel has been created! Visit it at https://Calm-River-7.trycloudflare.com now"),
    "https://calm-river-7.trycloudflare.com",
  );
  assert.equal(quickTunnelOrigin("no public URL yet"), null);
});

test("a tunneled HTTPS browser receives a Secure session cookie across the local HTTP hop", async () => {
  const previousApp = process.env.APP_ORIGIN;
  const previousShare = process.env.AUTOFORUM_SHARE_ORIGIN;
  process.env.APP_ORIGIN = "http://app.autoforum.localhost:5173";
  process.env.AUTOFORUM_SHARE_ORIGIN = "https://small-demo.trycloudflare.com";
  try {
    const app = new Hono();
    app.post("/", (context) => {
      setBrowserSessionCookie(context, "secret", new Date(Date.now() + 60_000));
      return context.json({ ok: true });
    });
    const response = await app.request("http://127.0.0.1:3000/", {
      method: "POST",
      headers: { origin: process.env.AUTOFORUM_SHARE_ORIGIN },
    });
    assert.match(response.headers.get("set-cookie") ?? "", /; Secure;/);
  } finally {
    if (previousApp === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousApp;
    if (previousShare === undefined) delete process.env.AUTOFORUM_SHARE_ORIGIN;
    else process.env.AUTOFORUM_SHARE_ORIGIN = previousShare;
  }
});
