import { randomBytes } from "node:crypto";
import path from "node:path";
import http from "node:http";
import { Writable } from "node:stream";

import Docker from "dockerode";
import { Hono, type Context } from "hono";
import tar from "tar-fs";

import { hasExactBrowserOrigin, readBrowserUser } from "../auth/browser.ts";
import type { AppDatabase } from "../db.ts";

const APP_LABEL = "org.autoforum.managed";
const PROJECT_LABEL = "org.autoforum.project";
const ROLE_LABEL = "org.autoforum.role";
export const SANDBOX_IMAGE = process.env.AUTOFORUM_SANDBOX_IMAGE ?? "autoforum-sandbox:v1";
export const SANDBOX_PREVIEW_HOST = "0.0.0.0";
export const SANDBOX_PREVIEW_PORT = 8080;
export const SANDBOX_SERVICE_GATEWAY_PORT = 8083;
export const SANDBOX_SERVICE_BROKER_PORT = 8084;
export const PREVIEW_RELAY_HEADER = "x-autoforum-preview-relay";
const APPLICATION_RELAY_PORT = "8081/tcp";
const SERVICE_GATEWAY_PORT = "8083/tcp";
const SERVICE_BROKER_PORT = "8084/tcp";

export interface ProjectPreviewTarget {
  host: string;
  port: number;
  relayToken: string;
}

export interface ProjectSandboxIdentity {
  projectId: number;
  publicId: string;
}

export interface SandboxServiceAccess {
  brokerToken: string;
  routes: Array<{
    name: string;
    grantToken: string;
    expiresAt: number;
  }>;
  connectBroker?: (target: ServiceBrokerTarget) => void;
}

export interface ServiceBrokerTarget {
  project: string;
  containerId: string;
  host: string;
  port: number;
}

function dockerOptions(host = process.env.DOCKER_HOST): Docker.DockerOptions {
  if (!host) {
    return process.platform === "win32"
      ? { socketPath: "//./pipe/docker_engine" }
      : { socketPath: "/var/run/docker.sock" };
  }
  if (host.startsWith("npipe://")) return { socketPath: host.slice("npipe://".length) };
  if (host.startsWith("unix://")) return { socketPath: host.slice("unix://".length) };
  const url = new URL(host.replace(/^tcp:/, "http:"));
  return {
    protocol: url.protocol === "https:" ? "https" : "http",
    host: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? 2376 : 2375)),
  };
}

export function createContainerEngine(): Docker {
  return new Docker(dockerOptions());
}

export function projectSandboxResourceNames(publicId: string) {
  const stem = `autoforum-${publicId}`;
  return {
    sandbox: `${stem}-sandbox`,
    sidecar: `${stem}-network`,
    internalNetwork: `${stem}-internal`,
    egressNetwork: `${stem}-egress`,
    workspaceVolume: `${stem}-workspace`,
    homeVolume: `${stem}-home`,
    cacheVolume: `${stem}-cache`,
  };
}

function labels(project: ProjectSandboxIdentity, role: string) {
  return {
    [APP_LABEL]: "true",
    [PROJECT_LABEL]: project.publicId,
    [ROLE_LABEL]: role,
    "org.autoforum.project-id": String(project.projectId),
  };
}

function notFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404;
}

async function ensureVolume(engine: Docker, name: string, project: ProjectSandboxIdentity, role: string) {
  try {
    await engine.getVolume(name).inspect();
  } catch (error) {
    if (!notFound(error)) throw error;
    await engine.createVolume({ Name: name, Labels: labels(project, role) });
  }
}

async function ensureNetwork(engine: Docker, name: string, project: ProjectSandboxIdentity, role: string, internal: boolean) {
  const existing = await engine.listNetworks({ filters: { name: [name] } });
  if (existing.some((network) => network.Name === name)) return engine.getNetwork(name);
  return await engine.createNetwork({ Name: name, Internal: internal, Labels: labels(project, role) });
}

async function findRoleContainer(engine: Docker, project: ProjectSandboxIdentity, role: string): Promise<Docker.Container | null> {
  const found = await engine.listContainers({
    all: true,
    filters: { label: [`${APP_LABEL}=true`, `${PROJECT_LABEL}=${project.publicId}`, `${ROLE_LABEL}=${role}`] },
  });
  if (found.length > 1) throw new Error(`duplicate_${role}_containers`);
  return found[0] ? engine.getContainer(found[0].Id) : null;
}

function runsWorkspaceShell(inspection: Docker.ContainerInspectInfo): boolean {
  return (inspection.Config.Cmd ?? []).some((part) => part.includes("autoforum-workspace-shell/server.mjs"));
}

function previewTarget(inspection: Docker.ContainerInspectInfo): ProjectPreviewTarget | null {
  const binding = inspection.NetworkSettings.Ports?.[APPLICATION_RELAY_PORT]?.[0];
  const port = Number(binding?.HostPort);
  const relayToken = configuredEnvironment(inspection, "AUTOFORUM_PREVIEW_RELAY_TOKEN");
  if (!binding || !Number.isSafeInteger(port) || port < 1 || !relayToken) return null;
  return {
    host: binding.HostIp === "0.0.0.0" || binding.HostIp === "::" ? "127.0.0.1" : binding.HostIp,
    port,
    relayToken,
  };
}

function serviceBrokerTarget(
  project: ProjectSandboxIdentity,
  inspection: Docker.ContainerInspectInfo,
): ServiceBrokerTarget | null {
  const binding = inspection.NetworkSettings.Ports?.[SERVICE_BROKER_PORT]?.[0];
  const port = Number(binding?.HostPort);
  if (!binding || !Number.isSafeInteger(port) || port < 1) return null;
  return {
    project: project.publicId,
    containerId: inspection.Id,
    host: binding.HostIp === "0.0.0.0" || binding.HostIp === "::" ? "127.0.0.1" : binding.HostIp,
    port,
  };
}

async function connectServiceBroker(
  project: ProjectSandboxIdentity,
  sidecar: Docker.Container,
  serviceAccess?: SandboxServiceAccess,
): Promise<void> {
  if (!serviceAccess?.connectBroker) return;
  const target = serviceBrokerTarget(project, await sidecar.inspect());
  if (!target) throw new Error("service_access_broker_unavailable");
  serviceAccess.connectBroker(target);
}

/** A valid HTTP response means the image-owned workspace shell is ready to receive a viewer. */
export function workspaceShellIsAvailable(target: ProjectPreviewTarget, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      resolve(available);
    };
    const request = http.request({
      host: target.host,
      port: target.port,
      path: "/",
      method: "HEAD",
      headers: { [PREVIEW_RELAY_HEADER]: target.relayToken },
      agent: false,
      timeout: timeoutMs,
    }, (response) => {
      response.destroy();
      finish(true);
    });
    request.once("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
    request.end();
  });
}

function configuredEnvironment(inspection: Docker.ContainerInspectInfo, name: string): string | undefined {
  return inspection.Config.Env?.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function serviceRoutesEnvironment(serviceAccess?: SandboxServiceAccess): string {
  return Buffer.from(JSON.stringify(serviceAccess?.routes ?? []), "utf8").toString("base64url");
}

async function ensureProjectResources(
  engine: Docker,
  project: ProjectSandboxIdentity,
  serviceAccess?: SandboxServiceAccess,
) {
  const image = await engine.getImage(SANDBOX_IMAGE).inspect();
  const resource = projectSandboxResourceNames(project.publicId);
  await Promise.all([
    ensureVolume(engine, resource.workspaceVolume, project, "workspace"),
    ensureVolume(engine, resource.homeVolume, project, "home"),
    ensureVolume(engine, resource.cacheVolume, project, "cache"),
  ]);
  const internal = await ensureNetwork(engine, resource.internalNetwork, project, "internal-network", true);
  const egress = await ensureNetwork(engine, resource.egressNetwork, project, "egress-network", false);
  const serviceRoutes = serviceRoutesEnvironment(serviceAccess);
  const serviceBrokerToken = serviceAccess?.brokerToken ?? "";

  let sidecar = await findRoleContainer(engine, project, "network");
  let applicationHostPort = "";
  let brokerHostPort = "";
  let previewRelayToken = randomBytes(32).toString("base64url");
  if (sidecar) {
    const inspection = await sidecar.inspect();
    applicationHostPort = inspection.NetworkSettings.Ports?.[APPLICATION_RELAY_PORT]?.[0]?.HostPort ?? "";
    brokerHostPort = inspection.NetworkSettings.Ports?.[SERVICE_BROKER_PORT]?.[0]?.HostPort ?? "";
    const existingPreviewRelayToken = configuredEnvironment(inspection, "AUTOFORUM_PREVIEW_RELAY_TOKEN");
    if (existingPreviewRelayToken) previewRelayToken = existingPreviewRelayToken;
    if (inspection.Image !== image.Id
      || !inspection.HostConfig.PortBindings?.[APPLICATION_RELAY_PORT]
      || !inspection.HostConfig.PortBindings?.[SERVICE_BROKER_PORT]
      || !existingPreviewRelayToken
      || configuredEnvironment(inspection, "AUTOFORUM_SERVICE_BROKER_TOKEN") !== serviceBrokerToken
      || configuredEnvironment(inspection, "AUTOFORUM_SERVICE_ROUTES") !== serviceRoutes) {
      await sidecar.remove({ force: true, v: false });
      sidecar = null;
    }
  }
  if (!sidecar) {
    sidecar = await engine.createContainer({
      name: resource.sidecar,
      Image: SANDBOX_IMAGE,
      Cmd: ["python3", "/usr/local/bin/autoforum-network-sidecar"],
      Env: [
        `AUTOFORUM_PREVIEW_HOST=${resource.sandbox}`,
        `AUTOFORUM_PREVIEW_PORT=${SANDBOX_PREVIEW_PORT}`,
        `AUTOFORUM_PREVIEW_RELAY_TOKEN=${previewRelayToken}`,
        `AUTOFORUM_SERVICE_BROKER_TOKEN=${serviceBrokerToken}`,
        `AUTOFORUM_SERVICE_ROUTES=${serviceRoutes}`,
      ],
      ExposedPorts: {
        [APPLICATION_RELAY_PORT]: {},
        [SERVICE_GATEWAY_PORT]: {},
        [SERVICE_BROKER_PORT]: {},
      },
      Labels: labels(project, "network"),
      HostConfig: {
        NetworkMode: resource.internalNetwork,
        PortBindings: {
          [APPLICATION_RELAY_PORT]: [{ HostIp: "127.0.0.1", HostPort: applicationHostPort }],
          [SERVICE_BROKER_PORT]: [{ HostIp: "127.0.0.1", HostPort: brokerHostPort }],
        },
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=32m" },
        Memory: 128 * 1024 * 1024,
        PidsLimit: 64,
      },
    });
    await egress.connect({ Container: sidecar.id });
  }

  let sandbox = await findRoleContainer(engine, project, "sandbox");
  if (sandbox) {
    const inspection = await sandbox.inspect();
    if (inspection.Image !== image.Id || !runsWorkspaceShell(inspection)) {
      await sandbox.remove({ force: true, v: false });
      sandbox = null;
    }
  }
  if (!sandbox) {
    sandbox = await engine.createContainer({
      name: resource.sandbox,
      Image: SANDBOX_IMAGE,
      Labels: labels(project, "sandbox"),
      Env: [
        `HTTP_PROXY=http://${resource.sidecar}:3128`,
        `HTTPS_PROXY=http://${resource.sidecar}:3128`,
        `http_proxy=http://${resource.sidecar}:3128`,
        `https_proxy=http://${resource.sidecar}:3128`,
        `NO_PROXY=localhost,127.0.0.1,::1,${resource.sidecar}`,
        `no_proxy=localhost,127.0.0.1,::1,${resource.sidecar}`,
        `HOST=${SANDBOX_PREVIEW_HOST}`,
        `PORT=${SANDBOX_PREVIEW_PORT}`,
      ],
      HostConfig: {
        NetworkMode: resource.internalNetwork,
        Binds: [
          `${resource.workspaceVolume}:/workspace`,
          `${resource.homeVolume}:/home/sandbox`,
          `${resource.cacheVolume}:/cache`,
        ],
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=512m" },
        Memory: 2 * 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        PidsLimit: 512,
        ShmSize: 256 * 1024 * 1024,
      },
    });
  }
  return { sandbox, sidecar, internal, egress };
}

async function startIfStopped(container: Docker.Container): Promise<void> {
  const inspection = await container.inspect();
  if (!inspection.State.Running) await container.start();
}

export async function startProjectSandbox(project: ProjectSandboxIdentity, serviceAccess?: SandboxServiceAccess) {
  const engine = createContainerEngine();
  await engine.ping();
  const resources = await ensureProjectResources(engine, project, serviceAccess);
  await startIfStopped(resources.sidecar);
  await connectServiceBroker(project, resources.sidecar, serviceAccess);
  await startIfStopped(resources.sandbox);
  return await projectSandboxStatus(project, engine);
}

export async function stopProjectSandbox(project: ProjectSandboxIdentity) {
  const engine = createContainerEngine();
  const sandbox = await findRoleContainer(engine, project, "sandbox");
  const sidecar = await findRoleContainer(engine, project, "network");
  if (sandbox && (await sandbox.inspect()).State.Running) await sandbox.stop({ t: 10 });
  if (sidecar) await sidecar.remove({ force: true, v: false });
  return await projectSandboxStatus(project, engine);
}

/** Apply changed paid routes without starting a stopped project sandbox. */
export async function synchronizeProjectSidecar(
  project: ProjectSandboxIdentity,
  serviceAccess?: SandboxServiceAccess,
): Promise<void> {
  const engine = createContainerEngine();
  await engine.ping();
  const sandbox = await findRoleContainer(engine, project, "sandbox");
  if (!sandbox || !(await sandbox.inspect()).State.Running) {
    const sidecar = await findRoleContainer(engine, project, "network");
    if (sidecar) await sidecar.remove({ force: true, v: false });
    return;
  }
  const resources = await ensureProjectResources(engine, project, serviceAccess);
  await startIfStopped(resources.sidecar);
  await connectServiceBroker(project, resources.sidecar, serviceAccess);
}

export async function getRunningProjectContainer(project: ProjectSandboxIdentity): Promise<Docker.Container> {
  const engine = createContainerEngine();
  const container = await findRoleContainer(engine, project, "sandbox");
  if (!container) throw new Error("sandbox_not_created");
  const inspection = await container.inspect();
  if (!inspection.State.Running) throw new Error("sandbox_not_running");
  return container;
}

export async function getProjectPreviewTarget(
  project: ProjectSandboxIdentity,
): Promise<ProjectPreviewTarget> {
  const engine = createContainerEngine();
  const [sandbox, sidecar] = await Promise.all([
    findRoleContainer(engine, project, "sandbox"),
    findRoleContainer(engine, project, "network"),
  ]);
  if (!sandbox || !sidecar) throw new Error("sandbox_not_created");
  const [sandboxInspection, sidecarInspection] = await Promise.all([sandbox.inspect(), sidecar.inspect()]);

  if (!sandboxInspection.State.Running || !sidecarInspection.State.Running) throw new Error("sandbox_not_running");
  if (!runsWorkspaceShell(sandboxInspection)) throw new Error("sandbox_image_outdated");
  const target = previewTarget(sidecarInspection);
  if (!target) throw new Error("sandbox_preview_unavailable");
  return target;
}

export async function projectSandboxStatus(project: ProjectSandboxIdentity, engine = createContainerEngine()) {
  await engine.ping();
  const sandbox = await findRoleContainer(engine, project, "sandbox");
  let imageAvailable = true;
  try { await engine.getImage(SANDBOX_IMAGE).inspect(); } catch (error) { if (notFound(error)) imageAvailable = false; else throw error; }
  if (!sandbox) return { state: "absent" as const, imageAvailable };
  const inspection = await sandbox.inspect();
  const running = inspection.State.Running;
  return {
    state: running ? "running" as const : "stopped" as const,
    imageAvailable,
    createdAt: inspection.Created,
  };
}

async function execText(container: Docker.Container, command: string[]): Promise<string> {
  const execution = await container.exec({ Cmd: command, AttachStdout: true, AttachStderr: true });
  const stream = await execution.start({ hijack: true });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const collect = (chunks: Buffer[]) => new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const stdoutCollector = collect(stdout);
  const stderrCollector = collect(stderr);
  container.modem.demuxStream(stream, stdoutCollector, stderrCollector);
  let inspected = await execution.inspect();
  while (inspected.Running) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    inspected = await execution.inspect();
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  stream.destroy();
  stdoutCollector.end();
  stderrCollector.end();
  const output = Buffer.concat(stdout).toString("utf8");
  const errors = Buffer.concat(stderr).toString("utf8");
  if ((inspected.ExitCode ?? -1) !== 0) throw new Error(`sandbox_inspection_failed:${errors.trim() || output.trim()}`);
  return output;
}

export async function resetProjectPreview(project: ProjectSandboxIdentity) {
  const engine = createContainerEngine();
  const sandbox = await findRoleContainer(engine, project, "sandbox");
  if (!sandbox) return { state: "absent" as const, dirty: [], commits: [] };
  const wasRunning = (await sandbox.inspect()).State.Running;
  if (!wasRunning) await sandbox.start();
  try {
    const output = await execText(sandbox, ["sh", "-lc", "printf '%s\\n' '__STATUS__'; git -C /workspace status --porcelain=v1; printf '%s\\n' '__COMMITS__'; git -C /workspace log --oneline -n 20"]);
    const [, afterStatus = ""] = output.split("__STATUS__\n", 2);
    const [status = "", commits = ""] = afterStatus.split("__COMMITS__\n", 2);
    return {
      state: wasRunning ? "running" as const : "stopped" as const,
      dirty: status.trim() ? status.trim().split("\n") : [],
      commits: commits.trim() ? commits.trim().split("\n") : [],
    };
  } finally {
    if (!wasRunning) await sandbox.stop({ t: 10 });
  }
}

export async function resetProjectSandbox(project: ProjectSandboxIdentity) {
  const engine = createContainerEngine();
  const resource = projectSandboxResourceNames(project.publicId);
  for (const role of ["sandbox", "network"]) {
    const container = await findRoleContainer(engine, project, role);
    if (container) await container.remove({ force: true, v: false });
  }
  for (const name of [resource.internalNetwork, resource.egressNetwork]) {
    try {
      const network = engine.getNetwork(name);
      const inspection = await network.inspect();
      if (inspection.Labels?.[PROJECT_LABEL] !== project.publicId) throw new Error("network_label_mismatch");
      await network.remove();
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }
  for (const name of [resource.workspaceVolume, resource.homeVolume, resource.cacheVolume]) {
    try {
      const volume = engine.getVolume(name);
      const inspection = await volume.inspect();
      if (inspection.Labels?.[PROJECT_LABEL] !== project.publicId) throw new Error("volume_label_mismatch");
      await volume.remove({ force: true });
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }
}

async function authorizedProject(context: Context, database: AppDatabase): Promise<ProjectSandboxIdentity | "unauthenticated" | "owner_required" | "project_not_found"> {
  const actor = await readBrowserUser(context, database);
  if (!actor) return "unauthenticated";
  if (!actor.isOwner) return "owner_required";
  const projectId = Number(context.req.param("projectId"));
  if (!Number.isSafeInteger(projectId) || projectId < 1) return "project_not_found";
  const result = await database.pool.query<{ projectId: number; publicId: string }>(
    `select p.row_id as "projectId", p.public_id as "publicId"
       from project p join project_member m on m.project_id = p.row_id
      where p.row_id = $1 and m.user_id = $2`,
    [projectId, actor.id],
  );
  return result.rows[0] ?? "project_not_found";
}

function authorizationResponse(context: Context, result: string) {
  return result === "unauthenticated"
    ? context.json({ error: result }, 401)
    : result === "owner_required"
      ? context.json({ error: result }, 403)
      : context.json({ error: result }, 404);
}

function engineFailure(context: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("sandbox_image") || message.includes("No such image") ? 409 : 503;
  return context.json({ error: message }, status as 409 | 503);
}

export function createSandboxLifecycleRoutes(database: AppDatabase, options: {
  serviceAccess?: (project: ProjectSandboxIdentity) => SandboxServiceAccess;
  onStopped?: (project: ProjectSandboxIdentity) => void;
} = {}) {
  const routes = new Hono();

  routes.get("/projects/:projectId/sandbox", async (context) => {
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    try { return context.json(await projectSandboxStatus(project)); }
    catch (error) { return engineFailure(context, error); }
  });

  routes.post("/projects/:projectId/sandbox/start", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    try { return context.json(await startProjectSandbox(project, options.serviceAccess?.(project))); }
    catch (error) { return engineFailure(context, error); }
  });

  routes.post("/projects/:projectId/sandbox/stop", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    try {
      const status = await stopProjectSandbox(project);
      options.onStopped?.(project);
      return context.json(status);
    }
    catch (error) { return engineFailure(context, error); }
  });

  routes.get("/projects/:projectId/sandbox/reset-preview", async (context) => {
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    try { return context.json(await resetProjectPreview(project)); }
    catch (error) { return engineFailure(context, error); }
  });

  routes.delete("/projects/:projectId/sandbox", async (context) => {
    if (!hasExactBrowserOrigin(context)) return context.json({ error: "invalid_origin" }, 403);
    const project = await authorizedProject(context, database);
    if (typeof project === "string") return authorizationResponse(context, project);
    const input = await context.req.json().catch(() => null) as { confirmation?: unknown } | null;
    if (input?.confirmation !== "RESET") return context.json({ error: "reset_confirmation_required" }, 400);
    try {
      await resetProjectSandbox(project);
      options.onStopped?.(project);
      return context.json({ state: "absent" });
    } catch (error) {
      return engineFailure(context, error);
    }
  });

  return routes;
}

export async function buildSandboxImage(onProgress?: (line: string) => void): Promise<void> {
  const engine = createContainerEngine();
  await engine.ping();
  const context = path.resolve("sandbox");
  const stream = await engine.buildImage(tar.pack(context), { t: SANDBOX_IMAGE, dockerfile: "Containerfile" });
  await new Promise<void>((resolve, reject) => {
    let streamedError: string | undefined;
    engine.modem.followProgress(stream, (error) => {
      if (error) reject(error);
      else if (streamedError) reject(new Error(streamedError));
      else resolve();
    }, (event: { stream?: string; error?: string }) => {
      if (event.error) streamedError = event.error;
      if (event.stream?.trim()) onProgress?.(event.stream.trim());
    });
  });
}

export async function reconcileSandboxes(
  serviceAccess?: (project: ProjectSandboxIdentity) => SandboxServiceAccess,
): Promise<string[]> {
  const engine = createContainerEngine();
  await engine.ping();
  const containers = await engine.listContainers({ all: true, filters: { label: [`${APP_LABEL}=true`, `${ROLE_LABEL}=sandbox`] } });
  const counts = new Map<string, number>();
  for (const container of containers) {
    const project = container.Labels?.[PROJECT_LABEL] ?? "missing-project-label";
    counts.set(project, (counts.get(project) ?? 0) + 1);
  }
  const duplicates = [...counts].filter(([, count]) => count !== 1).map(([project, count]) => `${project}:${count}`);
  if (serviceAccess) {
    for (const containerInfo of containers) {
      const publicId = containerInfo.Labels?.[PROJECT_LABEL];
      const projectId = Number(containerInfo.Labels?.["org.autoforum.project-id"]);
      if (!publicId || counts.get(publicId) !== 1 || !Number.isSafeInteger(projectId) || projectId < 1) continue;
      const wasRunning = containerInfo.State === "running";
      const project = { projectId, publicId };
      const serviceConfiguration = serviceAccess(project);
      const resources = await ensureProjectResources(engine, project, serviceConfiguration);
      if (wasRunning) {
        await startIfStopped(resources.sidecar);
        await connectServiceBroker(project, resources.sidecar, serviceConfiguration);
        await startIfStopped(resources.sandbox);
      }
    }
  }
  return duplicates;
}
