import { Writable } from "node:stream";

import type Docker from "dockerode";

import {
  getRunningProjectContainer,
  SANDBOX_PREVIEW_HOST,
  SANDBOX_PREVIEW_PORT,
  type ProjectSandboxIdentity,
} from "./lifecycle.ts";

export interface SandboxCommand {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", bytes: Buffer) => void;
}

export interface SandboxCommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

function validateCommand(command: SandboxCommand) {
  if (!command.argv.length || command.argv.length > 1_000) throw new Error("invalid_command");
  if (command.argv[0] === "" || command.argv.some((value) => value.includes("\0"))) throw new Error("invalid_command_argument");
  if (command.cwd && (!command.cwd.startsWith("/") || command.cwd.includes("\0"))) throw new Error("invalid_working_directory");
  for (const [key, value] of Object.entries(command.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) throw new Error("invalid_environment");
  }
}

async function terminateExecution(container: Docker.Container, execution: Docker.Exec) {
  const inspection = await execution.inspect().catch(() => null);
  if (!inspection?.Pid) return;
  const killer = await container.exec({ Cmd: ["kill", "-TERM", String(inspection.Pid)], AttachStdout: false, AttachStderr: false });
  await killer.start({}).catch(() => undefined);
}

export async function runSandboxCommand(
  project: ProjectSandboxIdentity,
  command: SandboxCommand,
): Promise<SandboxCommandResult> {
  validateCommand(command);
  const timeoutMs = command.timeoutMs ?? 60_000;
  const maxOutputBytes = command.maxOutputBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1_000) throw new Error("invalid_timeout");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 256 * 1024 * 1024) throw new Error("invalid_output_limit");
  if (command.signal?.aborted) throw new Error("command_aborted");

  const container = await getRunningProjectContainer(project);
  const environment = {
    HOST: SANDBOX_PREVIEW_HOST,
    PORT: String(SANDBOX_PREVIEW_PORT),
    ...command.env,
  };
  const execution = await container.exec({
    Cmd: command.argv,
    WorkingDir: command.cwd ?? "/workspace",
    Env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await execution.start({});
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let outputError: Error | undefined;

  function collector(kind: "stdout" | "stderr", destination: Buffer[]) {
    return new Writable({
      write(chunk, _encoding, callback) {
        const bytes = Buffer.from(chunk);
        outputBytes += bytes.length;
        if (outputBytes > maxOutputBytes) {
          outputError = new Error("command_output_too_large");
          callback(outputError);
          return;
        }
        destination.push(bytes);
        command.onOutput?.(kind, bytes);
        callback();
      },
    });
  }

  const stdoutCollector = collector("stdout", stdout);
  const stderrCollector = collector("stderr", stderr);
  stdoutCollector.on("error", () => undefined);
  stderrCollector.on("error", () => undefined);
  container.modem.demuxStream(stream, stdoutCollector, stderrCollector);

  let aborted = false;
  const abort = () => { aborted = true; };
  command.signal?.addEventListener("abort", abort, { once: true });
  const deadline = Date.now() + timeoutMs;
  try {
    let inspection = await execution.inspect();
    while (inspection.Running && !aborted && !outputError && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      inspection = await execution.inspect();
    }
    if (inspection.Running) await terminateExecution(container, execution);
    if (aborted) throw new Error("command_aborted");
    if (outputError) throw outputError;
    if (inspection.Running) throw new Error("command_timed_out");
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      exitCode: inspection.ExitCode ?? -1,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    };
  } finally {
    command.signal?.removeEventListener("abort", abort);
    stream.destroy();
    stdoutCollector.end();
    stderrCollector.end();
  }
}
