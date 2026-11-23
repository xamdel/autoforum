import assert from "node:assert/strict";
import test from "node:test";

import { validateProductionOrigins } from "../scripts/serve.ts";

test("production may use an apex for the forum and its first-level subdomains for previews", () => {
  const origins = validateProductionOrigins({
    APP_ORIGIN: "https://demo-forum.site",
    PREVIEW_BASE_ORIGIN: "https://demo-forum.site",
  });
  assert.equal(origins.app.origin, "https://demo-forum.site");
  assert.equal(origins.previewBase.origin, "https://demo-forum.site");
});

test("production may use separate forum and preview branches", () => {
  assert.doesNotThrow(() => validateProductionOrigins({
    APP_ORIGIN: "https://forum.example.com",
    PREVIEW_BASE_ORIGIN: "https://preview.example.com",
  }));
});

test("production requires exact HTTPS origins", () => {
  assert.throws(() => validateProductionOrigins({
    APP_ORIGIN: "http://example.com",
    PREVIEW_BASE_ORIGIN: "https://example.com",
  }), /app_origin_must_be_https_origin/);
  assert.throws(() => validateProductionOrigins({
    APP_ORIGIN: "https://example.com/path",
    PREVIEW_BASE_ORIGIN: "https://example.com",
  }), /app_origin_must_be_https_origin/);
  assert.throws(() => validateProductionOrigins({
    APP_ORIGIN: "https://example.com",
  }), /preview_base_origin_required/);
});

test("the forum cannot be captured by the preview-host suffix", () => {
  assert.throws(() => validateProductionOrigins({
    APP_ORIGIN: "https://forum.example.com",
    PREVIEW_BASE_ORIGIN: "https://example.com",
  }), /app_origin_must_not_be_preview_subdomain/);
});
