import assert from "node:assert/strict";
import test from "node:test";

import {
  managedPostgresContainerFromEnvironment,
  parseManagedPostgresPort,
} from "../src/managed-postgres.ts";
import { updateEnvironmentText } from "../scripts/setup.ts";

test("managed PostgreSQL is opt-in through one concrete container name", () => {
  assert.equal(managedPostgresContainerFromEnvironment({}), null);
  assert.equal(managedPostgresContainerFromEnvironment({
    AUTOFORUM_MANAGED_POSTGRES_CONTAINER: "autoforum-postgres",
  }), "autoforum-postgres");
  assert.throws(
    () => managedPostgresContainerFromEnvironment({ AUTOFORUM_MANAGED_POSTGRES_CONTAINER: "bad name" }),
    /invalid/,
  );
});

test("Podman's loopback port output becomes the database port", () => {
  assert.equal(parseManagedPostgresPort("127.0.0.1:49152\n"), 49_152);
  assert.equal(parseManagedPostgresPort("0.0.0.0:5432\n[::]:5432\n"), 5_432);
  assert.throws(() => parseManagedPostgresPort(""), /port_unavailable/);
});

test("setup updates owned env values without disturbing provider keys or comments", () => {
  const updated = updateEnvironmentText(
    "# local settings\nDATABASE_URL=old\nDOCKER_HOST=unix:///old.sock\nOPENROUTER_API_KEY=keep-me\n",
    {
      DATABASE_URL: "postgres://new",
      AUTOFORUM_MANAGED_POSTGRES_CONTAINER: "autoforum-postgres",
      DOCKER_HOST: "unix:///run/user/1000/podman/podman.sock",
    },
  );
  assert.equal(updated, [
    "# local settings",
    "DATABASE_URL=postgres://new",
    "DOCKER_HOST=unix:///run/user/1000/podman/podman.sock",
    "OPENROUTER_API_KEY=keep-me",
    "",
    "AUTOFORUM_MANAGED_POSTGRES_CONTAINER=autoforum-postgres",
    "",
  ].join("\n"));
});
