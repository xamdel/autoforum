import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  projectSandboxResourceNames,
  SANDBOX_SERVICE_GATEWAY_PORT,
  type ProjectSandboxIdentity,
  type SandboxServiceAccess,
} from "../sandbox/lifecycle.ts";

export const SERVICE_ACCESS_GRANT_MS = 60 * 60 * 1_000;

const RESERVED_ENVIRONMENT = new Set(["HOME", "HOST", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "PATH", "PORT"]);
const environmentName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/).refine(
  (value) => !RESERVED_ENVIRONMENT.has(value) && !value.startsWith("AUTOFORUM_"),
  "reserved environment variable",
);
export const serviceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/).refine(
  (value) => !new Set(["connection", "content-length", "cookie", "host", "proxy-authorization", "set-cookie"]).has(value.toLowerCase()),
);

export const serviceSchema = z.object({
  name: serviceNameSchema,
  upstream: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:"
      && (!url.port || url.port === "443")
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  }, "upstream must be a plain HTTPS base URL on port 443"),
  baseUrlEnv: environmentName,
  credentialEnv: environmentName,
  authHeader: headerName,
  authPrefix: z.string().max(100).regex(/^[\x20-\x7e]*$/).default(""),
}).strict().refine((service) => service.baseUrlEnv !== service.credentialEnv, "baseUrlEnv and credentialEnv must differ");

export type ServiceConfiguration = z.infer<typeof serviceSchema>;

export const modelCredentialSourceSchema = z.object({
  type: z.literal("model-api-key"),
  provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
}).strict();
export type ModelCredentialSource = z.infer<typeof modelCredentialSourceSchema>;

const savedServiceSchema = z.object({
  service: serviceSchema,
  credential: z.string().min(1).max(16_384).optional(),
  credentialSource: modelCredentialSourceSchema.optional(),
  updatedAt: z.iso.datetime(),
}).strict().refine((saved) => Boolean(saved.credential) !== Boolean(saved.credentialSource), {
  message: "exactly one credential source is required",
});

const storeSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), z.record(z.string(), savedServiceSchema)),
}).strict();

type ServiceStore = z.infer<typeof storeSchema>;

export interface ServiceStatus extends ServiceConfiguration {
  grantedUntil: string | null;
  credentialSource?: ModelCredentialSource;
}

export interface ServiceGrant {
  service: ServiceConfiguration;
  credential: string;
}

interface ActiveGrant {
  publicId: string;
  name: string;
  token: string;
  expiresAt: number;
}

export interface ModelCredentialAccess {
  service(provider: string): ServiceConfiguration | null;
  resolve(provider: string): Promise<string | null>;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function checkedCredential(input: string | undefined, existing: string | undefined): string {
  const credential = input?.trim() || existing;
  if (!credential) throw new Error("service_access_credential_required");
  if (credential.length > 16_384) throw new Error("service_access_credential_too_large");
  if (!/^[\x20-\x7e]+$/.test(credential)) throw new Error("service_access_credential_must_be_ascii");
  return credential;
}

function assertEnvironmentNamesAvailable(
  services: Record<string, z.infer<typeof savedServiceSchema>>,
  candidate: ServiceConfiguration,
): void {
  for (const [name, saved] of Object.entries(services)) {
    if (name === candidate.name) continue;
    const used = new Set([saved.service.baseUrlEnv, saved.service.credentialEnv]);
    if (used.has(candidate.baseUrlEnv) || used.has(candidate.credentialEnv)) throw new Error("service_access_environment_conflict");
  }
}

/** Host-owned authenticated-service configurations and their short-lived project grants. */
export class ServiceAccess {
  readonly #filename: string;
  readonly #modelCredentials: ModelCredentialAccess | undefined;
  #store: ServiceStore;
  #grants = new Map<string, ActiveGrant>();
  #writes = Promise.resolve();

  private constructor(filename: string, store: ServiceStore, modelCredentials?: ModelCredentialAccess) {
    this.#filename = filename;
    this.#store = store;
    this.#modelCredentials = modelCredentials;
  }

  static async open(options: { filename?: string; modelCredentials?: ModelCredentialAccess } = {}): Promise<ServiceAccess> {
    const filename = options.filename ?? path.resolve(".autoforum", "service-credentials.json");
    let store: ServiceStore = { version: 1, projects: {} };
    try { store = storeSchema.parse(JSON.parse(await readFile(filename, "utf8"))); }
    catch (error) {
      if (!isMissingFile(error)) throw new Error("invalid_service_credential_store", { cause: error });
    }
    return new ServiceAccess(filename, store, options.modelCredentials);
  }

  #grantKey(publicId: string, name: string): string {
    return `${publicId}:${name}`;
  }

  sidecarConfiguration(
    project: ProjectSandboxIdentity,
    brokerToken: string,
    now = Date.now(),
  ): SandboxServiceAccess {
    const routes = [...this.#grants.values()]
      .filter((grant) => grant.publicId === project.publicId && grant.expiresAt > now)
      .map((grant) => ({ name: grant.name, grantToken: grant.token, expiresAt: grant.expiresAt }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return { brokerToken, routes };
  }

  async resolveGrant(token: string, name: string, now = Date.now()): Promise<ServiceGrant | null> {
    const grant = [...this.#grants.values()].find((candidate) => (
      candidate.token === token && candidate.name === name && candidate.expiresAt > now
    ));
    if (!grant) return null;
    const saved = this.#store.projects[grant.publicId]?.[grant.name];
    if (!saved) return null;
    const credential = saved.credential ?? (saved.credentialSource
      ? await this.#modelCredentials?.resolve(saved.credentialSource.provider)
      : null);
    return credential ? { service: saved.service, credential } : null;
  }

  list(publicId: string, now = Date.now()): ServiceStatus[] {
    const saved = this.#store.projects[publicId] ?? {};
    return Object.values(saved)
      .map(({ service, credentialSource }) => {
        const key = this.#grantKey(publicId, service.name);
        const grant = this.#grants.get(key);
        if (grant && grant.expiresAt <= now) this.#grants.delete(key);
        return {
          ...service,
          ...(credentialSource ? { credentialSource } : {}),
          grantedUntil: grant && grant.expiresAt > now ? new Date(grant.expiresAt).toISOString() : null,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  hasActiveGrant(publicId: string, name: string, now = Date.now()): boolean {
    const key = this.#grantKey(publicId, name);
    const grant = this.#grants.get(key);
    if (grant && grant.expiresAt <= now) this.#grants.delete(key);
    return Boolean(grant && grant.expiresAt > now);
  }

  async configure(publicId: string, service: ServiceConfiguration, credential?: string, now = Date.now()): Promise<ServiceStatus> {
    const parsed = serviceSchema.parse(service);
    await this.#update((next) => {
      const services = next.projects[publicId] ?? {};
      assertEnvironmentNamesAvailable(services, parsed);
      const checked = checkedCredential(credential, services[parsed.name]?.credential);
      next.projects[publicId] ??= {};
      next.projects[publicId]![parsed.name] = { service: parsed, credential: checked, updatedAt: new Date(now).toISOString() };
    });
    this.revokeGrant(publicId, parsed.name);
    return { ...parsed, grantedUntil: null };
  }

  modelService(provider: string): ServiceConfiguration | null {
    return this.#modelCredentials?.service(provider) ?? null;
  }

  async configureModelProvider(publicId: string, provider: string, now = Date.now()): Promise<ServiceStatus> {
    const service = this.modelService(provider);
    if (!service) throw new Error("service_access_model_provider_not_supported");
    const parsed = serviceSchema.parse(service);
    await this.#update((next) => {
      const services = next.projects[publicId] ?? {};
      assertEnvironmentNamesAvailable(services, parsed);
      next.projects[publicId] ??= {};
      next.projects[publicId]![parsed.name] = {
        service: parsed,
        credentialSource: { type: "model-api-key", provider },
        updatedAt: new Date(now).toISOString(),
      };
    });
    this.revokeGrant(publicId, parsed.name);
    return { ...parsed, credentialSource: { type: "model-api-key", provider }, grantedUntil: null };
  }

  async grant(publicId: string, name: string, now = Date.now()): Promise<ServiceStatus> {
    const saved = this.#store.projects[publicId]?.[name];
    if (!saved) throw new Error("service_access_not_configured");
    if (saved.credentialSource && !(await this.#modelCredentials?.resolve(saved.credentialSource.provider))) {
      throw new Error("service_access_model_api_key_unavailable");
    }
    const expiresAt = now + SERVICE_ACCESS_GRANT_MS;
    this.#grants.set(this.#grantKey(publicId, name), {
      publicId,
      name,
      token: randomBytes(32).toString("base64url"),
      expiresAt,
    });
    return {
      ...saved.service,
      ...(saved.credentialSource ? { credentialSource: saved.credentialSource } : {}),
      grantedUntil: new Date(expiresAt).toISOString(),
    };
  }

  revokeGrant(publicId: string, name: string): void {
    this.#grants.delete(this.#grantKey(publicId, name));
  }

  revokeProject(publicId: string): void {
    for (const key of this.#grants.keys()) if (key.startsWith(`${publicId}:`)) this.#grants.delete(key);
  }

  async remove(publicId: string, name: string): Promise<void> {
    await this.#update((next) => {
      delete next.projects[publicId]?.[name];
      if (next.projects[publicId] && !Object.keys(next.projects[publicId]!).length) delete next.projects[publicId];
    });
    this.revokeGrant(publicId, name);
  }

  environment(project: ProjectSandboxIdentity): Record<string, string> {
    const relay = projectSandboxResourceNames(project.publicId).sidecar;
    const environment: Record<string, string> = {};
    for (const { service } of Object.values(this.#store.projects[project.publicId] ?? {})) {
      environment[service.baseUrlEnv] = `http://${relay}:${SANDBOX_SERVICE_GATEWAY_PORT}/${service.name}`;
      environment[service.credentialEnv] = "via-autoforum-service-access";
    }
    return environment;
  }

  async #update(change: (store: ServiceStore) => void): Promise<void> {
    const write = this.#writes.then(async () => {
      const store = structuredClone(this.#store);
      change(store);
      await mkdir(path.dirname(this.#filename), { recursive: true });
      const temporary = `${this.#filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, this.#filename);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      this.#store = store;
    });
    this.#writes = write.catch(() => undefined);
    await write;
  }
}
