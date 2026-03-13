/**
 * ACP Bridge Client — routes LLM calls over stdio instead of CLI args.
 *
 * Replaces callLLMviaAgent() (which used execFile + --message flag and hit
 * Linux's ARG_MAX ~2MB ceiling) with the ACP stdio bridge (openclaw acp).
 * Prompts travel over stdin/stdout — no argument size limit.
 *
 * @agentclientprotocol/sdk is ESM-only; we use a static `import type` with
 * resolution-mode="import" for types, plus a runtime dynamic import().
 */

import { spawn, type ChildProcess } from "child_process";
import { Readable, Writable } from "stream";

// Type-only import with resolution-mode tells TypeScript to resolve this
// ESM package's types from a CommonJS module file.
import type {
  Client,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk" with { "resolution-mode": "import" };

// Errors that indicate a transient WebSocket / gateway connection failure.
// These are safe to retry — the LLM is still running; we just need a new bridge.
function isTransientError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes("gateway disconnected") ||
    msg.includes("-32603") ||
    msg.includes("1005") ||
    msg.includes("websocket") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("connection closed") ||
    msg.includes("socket hang up")
  );
}

// Structural interface for the subset of the SDK we use, avoiding the
// `typeof import(...)` pattern which TypeScript rejects in CJS→ESM context.
interface AcpModules {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ClientSideConnection: new (toClient: (_agent: unknown) => Client, stream: any) => {
    initialize(p: { protocolVersion: number }): Promise<unknown>;
    newSession(p: { cwd: string; mcpServers: unknown[] }): Promise<{ sessionId: string }>;
    prompt(p: { sessionId: string; prompt: Array<{ type: "text"; text: string }> }): Promise<unknown>;
  };
  ndJsonStream(writable: WritableStream<Uint8Array>, readable: ReadableStream<Uint8Array>): unknown;
  PROTOCOL_VERSION: number;
}

/** Single connection attempt. Throws on any failure. */
async function runAttempt(
  prompt: string,
  agentId: string,
  { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION }: AcpModules,
): Promise<string> {
  const sessionKey = `agent:${agentId}:main`;
  const child: ChildProcess = spawn("openclaw", [
    "acp",
    "--session", sessionKey,
    "--reset-session",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    console.error(`[ACP stderr] ${chunk.toString().trim()}`);
  });

  let childExitCode: number | null = null;
  let childExited = false;
  const childClosePromise = new Promise<void>((resolve) => {
    child.on("close", (code) => {
      childExitCode = code;
      childExited = true;
      resolve();
    });
  });

  const writableWeb = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const readableWeb = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(writableWeb, readableWeb);

  let responseText = "";

  const clientHandler = (_agent: unknown): Client => ({
    sessionUpdate(notification: SessionNotification) {
      const update = notification.update;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        responseText += update.content.text;
      }
      return Promise.resolve();
    },
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const allowOption =
        params.options.find((o) => o.kind === "allow_once") ?? params.options[0];
      return Promise.resolve({
        outcome: {
          outcome: "selected" as const,
          optionId: allowOption.optionId,
        },
      });
    },
  });

  const connection = new ClientSideConnection(clientHandler, stream);

  try {
    const result = await Promise.race([
      (async () => {
        await connection.initialize({ protocolVersion: PROTOCOL_VERSION });
        const session = await connection.newSession({
          cwd: process.cwd(),
          mcpServers: [],
        });
        await connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text" as const, text: prompt }],
        });
        return responseText.trim();
      })(),
      // Fail fast if the child exits with a non-zero code before we get a response.
      childClosePromise.then(() => {
        if (childExited && !responseText && childExitCode !== 0) {
          throw new Error(
            `ACP bridge exited with code ${childExitCode}. Is the OpenClaw Gateway running?`,
          );
        }
        return responseText.trim();
      }),
    ]);

    return result;
  } finally {
    if (!childExited) {
      child.kill("SIGTERM");
    }
  }
}

/**
 * Send a prompt to the OpenClaw Gateway via the ACP stdio bridge.
 * No ARG_MAX limit — the prompt travels over stdin, not CLI arguments.
 *
 * Automatically retries up to 3 times on transient WebSocket / gateway
 * disconnection errors (e.g. JSON-RPC -32603, WS close code 1005).
 *
 * @param prompt  - The full prompt text (arbitrarily large)
 * @param agentId - The agent identifier (default: "main")
 * @returns         The LLM's text response
 */
export async function sendPromptViaACP(
  prompt: string,
  agentId = "main",
): Promise<string> {
  // Load the ESM-only SDK once; reused across retries.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acpModules = await import("@agentclientprotocol/sdk") as any as AcpModules;

  const MAX_RETRIES = 3;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 2s, 4s before attempts 2 and 3.
      const delayMs = 2 ** attempt * 1000;
      console.warn(`[ACP] Gateway disconnected. Retry ${attempt}/${MAX_RETRIES - 1} in ${delayMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }

    try {
      return await runAttempt(prompt, agentId, acpModules);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;

      if (attempt < MAX_RETRIES - 1 && isTransientError(error)) {
        console.warn(`[ACP] Transient error on attempt ${attempt + 1}: ${error.message}`);
        continue;
      }

      throw error;
    }
  }

  throw lastError ?? new Error("ACP bridge failed after all retries");
}
