import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServiceRelay } from "../src/service-access/relay.ts";
import { ServiceAccess, serviceSchema, type ServiceConfiguration } from "../src/service-access/services.ts";

const service: ServiceConfiguration = {
  name: "speech",
  upstream: "https://api.example.com/v1",
  baseUrlEnv: "EXAMPLE_BASE_URL",
  credentialEnv: "EXAMPLE_API_KEY",
  authHeader: "Authorization",
  authPrefix: "Bearer ",
};

test("host-owned authenticated services are provider-neutral but narrowly shaped", () => {
  assert.equal(serviceSchema.parse(service).name, "speech");
  assert.throws(() => serviceSchema.parse({ ...service, upstream: "http://api.example.com" }));
  assert.throws(() => serviceSchema.parse({ ...service, upstream: "https://api.example.com:8443" }));
  assert.throws(() => serviceSchema.parse({ ...service, credentialEnv: "PATH" }));
  assert.throws(() => serviceSchema.parse({ ...service, authPrefix: "Bearer\r\nX-Evil: yes" }));
});

test("configuration supplies only relay and placeholder values to sandbox commands", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autoforum-service-access-"));
  const access = await ServiceAccess.open({ filename: path.join(directory, "keys.json") });
  const project = { projectId: 1, publicId: "project-one" };
  const now = Date.now();
  try {
    await access.configure(project.publicId, service, "stored-key", now);
    assert.equal(access.hasActiveGrant(project.publicId, service.name, now), false);
    assert.deepEqual(access.list(project.publicId, now), [{ ...service, grantedUntil: null }]);
    const environment = access.environment(project);
    assert.match(environment.EXAMPLE_BASE_URL ?? "", /:8083\/speech$/);
    assert.equal(environment.EXAMPLE_API_KEY, "via-autoforum-service-access");
    assert.equal(JSON.stringify(environment).includes("stored-key"), false);

    await access.grant(project.publicId, service.name, now);
    assert.equal(access.hasActiveGrant(project.publicId, service.name, now), true);
    const sidecar = access.sidecarConfiguration(project, "disposable-broker-token", now);
    assert.equal(sidecar.routes.length, 1);
    assert.equal(JSON.stringify(sidecar).includes("stored-key"), false);
    assert.deepEqual(await access.resolveGrant(sidecar.routes[0]!.grantToken, service.name, now), {
      service,
      credential: "stored-key",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("changing a host configuration revokes its active grant", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autoforum-service-access-"));
  const access = await ServiceAccess.open({ filename: path.join(directory, "keys.json") });
  const project = { projectId: 1, publicId: "project-one" };
  try {
    await access.configure(project.publicId, service, "stored-key");
    await access.grant(project.publicId, service.name);
    await access.configure(project.publicId, { ...service, upstream: "https://api.example.net/v2" });
    assert.equal(access.sidecarConfiguration(project, "broker").routes.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("model service grants resolve the current host API key without copying it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autoforum-model-service-access-"));
  const filename = path.join(directory, "keys.json");
  const modelService: ServiceConfiguration = {
    name: "model-openai",
    upstream: "https://api.openai.com/v1",
    baseUrlEnv: "OPENAI_BASE_URL",
    credentialEnv: "OPENAI_API_KEY",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  };
  let currentKey: string | null = "first-model-key";
  const access = await ServiceAccess.open({
    filename,
    modelCredentials: {
      service: (provider) => provider === "openai" ? modelService : null,
      resolve: async (provider) => provider === "openai" ? currentKey : null,
    },
  });
  const project = { projectId: 1, publicId: "project-one" };
  const now = Date.now();
  try {
    await access.configureModelProvider(project.publicId, "openai", now);
    assert.deepEqual(access.list(project.publicId, now), [{
      ...modelService,
      credentialSource: { type: "model-api-key", provider: "openai" },
      grantedUntil: null,
    }]);
    assert.equal((await readFile(filename, "utf8")).includes("first-model-key"), false);
    assert.equal(access.environment(project).OPENAI_API_KEY, "via-autoforum-service-access");

    await access.grant(project.publicId, modelService.name, now);
    const sidecar = access.sidecarConfiguration(project, "broker", now);
    assert.equal(JSON.stringify(sidecar).includes("first-model-key"), false);
    assert.deepEqual(await access.resolveGrant(sidecar.routes[0]!.grantToken, modelService.name, now), {
      service: modelService,
      credential: "first-model-key",
    });

    currentKey = "rotated-model-key";
    assert.equal(
      (await access.resolveGrant(sidecar.routes[0]!.grantToken, modelService.name, now))?.credential,
      "rotated-model-key",
    );
    currentKey = null;
    assert.equal(await access.resolveGrant(sidecar.routes[0]!.grantToken, modelService.name, now), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stored credentials do not become live sidecar routes after restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autoforum-service-access-"));
  const filename = path.join(directory, "keys.json");
  try {
    await writeFile(filename, JSON.stringify({
      version: 1,
      projects: {
        "project-one": {
          speech: { service, credential: "stored-key", updatedAt: new Date().toISOString() },
        },
      },
    }));
    const reopened = await ServiceAccess.open({ filename });
    const sidecar = reopened.sidecarConfiguration(
      { projectId: 1, publicId: "project-one" },
      "disposable-broker-token",
    );
    assert.deepEqual(sidecar, {
      brokerToken: "disposable-broker-token",
      routes: [],
    });
    assert.equal(JSON.stringify(sidecar).includes("stored-key"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the host relay refuses requests without a live sidecar grant", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autoforum-service-relay-"));
  const access = await ServiceAccess.open({ filename: path.join(directory, "keys.json") });
  const relay = await startServiceRelay(access);
  try {
    const response = await fetch(`${relay.localOrigin}/speech`, {
      headers: { "x-autoforum-service-grant": "not-a-live-grant" },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "service_access_not_granted" });
  } finally {
    await relay.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent service changes preserve both services", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "autoforum-service-access-"));
  const access = await ServiceAccess.open({ filename: path.join(directory, "keys.json") });
  try {
    await Promise.all([
      access.configure("project-one", service, "first-key"),
      access.configure("project-one", {
        ...service,
        name: "images",
        baseUrlEnv: "IMAGES_BASE_URL",
        credentialEnv: "IMAGES_API_KEY",
      }, "second-key"),
    ]);
    assert.deepEqual(access.list("project-one").map((saved) => saved.name), ["images", "speech"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
