import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

export class PodmanCommandError extends Error {
  readonly exitCode: number;

  constructor(operation: string, exitCode: number, output: string) {
    super(`podman_${operation}_failed:${exitCode}${output.trim() ? `:${output.trim()}` : ""}`);
    this.exitCode = exitCode;
  }
}

export async function runPodman(
  operation: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("podman", args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") reject(new Error("podman_not_installed"));
      else reject(error);
    });
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve(output);
      else reject(new PodmanCommandError(operation, code ?? -1, errors || output));
    });
  });
}

export async function verifyPodmanCli(): Promise<void> {
  await runPodman("info", ["info", "--format", "json"]);
}

interface MachineInspection {
  Name?: string;
  State?: string;
  ConnectionInfo?: {
    PodmanPipe?: { Path?: string };
    PodmanSocket?: { Path?: string };
  };
}

async function inspectPodmanMachines(environment = process.env): Promise<MachineInspection[]> {
  return JSON.parse(await runPodman("machine_inspect", ["machine", "inspect"], environment)) as MachineInspection[];
}

/** Uses the configured endpoint or discovers the running desktop machine's forwarded API. */
export async function configurePodmanDockerHost(
  platform = process.platform,
  environment = process.env,
): Promise<string | null> {
  const configured = environment.DOCKER_HOST?.trim();
  if (configured) return configured;
  if (platform !== "win32" && platform !== "darwin") return null;

  const inspections = await inspectPodmanMachines(environment);
  const machine = inspections.find((candidate) => candidate.State === "running") ?? inspections[0];
  if (!machine) throw new Error("podman_machine_missing");
  const pipe = machine.ConnectionInfo?.PodmanPipe?.Path?.trim();
  const socket = machine.ConnectionInfo?.PodmanSocket?.Path?.trim();
  const host = platform === "win32" && pipe
    ? `npipe://${pipe.replaceAll("\\", "/")}`
    : socket
      ? `unix://${socket}`
      : null;
  if (!host) throw new Error("podman_machine_api_endpoint_missing");
  environment.DOCKER_HOST = host;
  return host;
}

/** Starts an already-configured default Podman machine when Windows or macOS needs it. */
export async function ensurePodmanMachineRunning(platform = process.platform): Promise<boolean> {
  try {
    await verifyPodmanCli();
    await configurePodmanDockerHost(platform);
    return false;
  } catch (initialError) {
    if (platform !== "win32" && platform !== "darwin") throw initialError;
    try {
      await runPodman("machine_start", ["machine", "start", "--quiet"]);
    } catch (startError) {
      // A concurrent launcher may have started the machine after the first check.
      try {
        await verifyPodmanCli();
        await configurePodmanDockerHost(platform);
        return false;
      } catch {
        throw startError;
      }
    }
    await verifyPodmanCli();
    await configurePodmanDockerHost(platform);
    return true;
  }
}

/** Recreates a stale desktop API forwarder only when doing so cannot interrupt a running container. */
export async function restartIdlePodmanMachine(platform = process.platform): Promise<void> {
  if (platform !== "win32" && platform !== "darwin") throw new Error("podman_machine_restart_not_supported");
  const running = await runPodman("running_containers", ["ps", "--quiet"]);
  if (running.trim()) throw new Error("podman_machine_api_unavailable_with_running_containers");
  const inspections = await inspectPodmanMachines();
  const machine = inspections.find((candidate) => candidate.State === "running") ?? inspections[0];
  const staleSocket = machine?.ConnectionInfo?.PodmanSocket?.Path?.trim();
  let staleSocketTarget: string | null = null;
  if (platform === "win32" && staleSocket) {
    const temporaryPodmanDirectory = path.resolve(os.tmpdir(), "podman");
    const target = path.resolve(staleSocket);
    const relative = path.relative(temporaryPodmanDirectory, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith("-api.sock")) {
      throw new Error("podman_machine_socket_path_unexpected");
    }
    staleSocketTarget = target;
  }
  await runPodman("machine_stop", ["machine", "stop"]);
  let cleanupError: unknown;
  if (staleSocketTarget) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await rm(staleSocketTarget, { force: true });
        cleanupError = undefined;
        break;
      } catch (error) {
        cleanupError = error;
        await delay(250);
      }
    }
  }
  // Do not leave the user's machine stopped even if Windows never releases the stale socket.
  await runPodman("machine_start", ["machine", "start", "--quiet"]);
  if (cleanupError) throw new Error("podman_machine_stale_socket_removal_failed", { cause: cleanupError });
  await verifyPodmanCli();
}
