import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { PgBoss } from "pg-boss";

const AGENT_TURN_QUEUE = "agent-turn";
const AGENT_PAUSE_FILE = path.resolve(".autoforum", "agent-turns-paused");

export async function startQueue(connectionString: string, onError?: (error: unknown) => void) {
  const queue = new PgBoss({
    connectionString,
    schema: "pgboss",
    application_name: "autoforum-worker",
  });
  queue.on("error", (error) => {
    if (onError) onError(error);
    else console.error("Queue error", error);
  });
  try {
    await queue.start();
    await queue.createQueue(AGENT_TURN_QUEUE, { retryLimit: 0 });
  } catch (error) {
    await queue.stop({ graceful: false }).catch(() => undefined);
    throw error;
  }
  let running = true;
  let agentTurnsPaused = await access(AGENT_PAUSE_FILE).then(() => true, () => false);
  let agentTurnHandler: ((turnId: number, signal: AbortSignal) => Promise<void>) | undefined;
  let agentWorkerId: string | undefined;
  let workerTransition = Promise.resolve();

  const reconcileAgentWorker = () => {
    const transition = workerTransition.then(async () => {
      if (!running) return;
      if (agentTurnsPaused && agentWorkerId) {
        const workerId = agentWorkerId;
        // Stop fetching immediately, then wait in the background for the current turn to finish.
        await queue.offWork(AGENT_TURN_QUEUE, { id: workerId, wait: true });
        agentWorkerId = undefined;
      } else if (!agentTurnsPaused && !agentWorkerId && agentTurnHandler) {
        agentWorkerId = await queue.work<{ turnId: number }>(
          AGENT_TURN_QUEUE,
          { batchSize: 1, localConcurrency: 1 },
          async (jobs) => {
            for (const job of jobs) await agentTurnHandler!(job.data.turnId, job.signal);
          },
        );
      }
    });
    // Keep later control changes usable after a failure, while allowing startup to fail loudly.
    workerTransition = transition.catch((error) => {
      if (onError) onError(error);
      else console.error("Could not change agent worker state", error);
    });
    return transition;
  };

  return {
    isRunning: () => running,
    areAgentTurnsPaused: () => agentTurnsPaused,
    async setAgentTurnsPaused(paused: boolean) {
      if (paused) {
        await mkdir(path.dirname(AGENT_PAUSE_FILE), { recursive: true });
        await writeFile(AGENT_PAUSE_FILE, "paused\n", "utf8");
      } else {
        await unlink(AGENT_PAUSE_FILE).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      agentTurnsPaused = paused;
      void reconcileAgentWorker();
    },
    async enqueueAgentTurns(turnIds: number[]) {
      for (const turnId of turnIds) {
        await queue.send(AGENT_TURN_QUEUE, { turnId }, { retryLimit: 0, expireInSeconds: 10 * 60 });
      }
    },
    async workAgentTurns(handler: (turnId: number, signal: AbortSignal) => Promise<void>) {
      if (agentTurnHandler) throw new Error("Agent turn worker is already registered");
      agentTurnHandler = handler;
      await reconcileAgentWorker();
    },
    async stop() {
      if (!running) return;
      running = false;
      await queue.stop({ graceful: true, timeout: 10_000 });
    },
  };
}
