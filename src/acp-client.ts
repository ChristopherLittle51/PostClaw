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

/**
 * Send a prompt to the OpenClaw Gateway via the ACP stdio bridge.
 * No ARG_MAX limit — the prompt travels over stdin, not CLI arguments.
 *
 * @param prompt  - The full prompt text (arbitrarily large)
 * @param agentId - The agent identifier (default: "main")
 * @returns         The LLM's text response
 */
export async function sendPromptViaACP(
  prompt: string,
  agentId = "main",
): Promise<string> {
  // Dynamic import handles the ESM-only SDK from this CJS module at runtime.
  const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } =
    await import("@agentclientprotocol/sdk");

  // 1. Spawn the ACP bridge as a child process.
  //    --reset-session ensures a clean context per call (single-shot semantics).
  const sessionKey = `agent:${agentId}:main`;
  const child: ChildProcess = spawn("openclaw", [
    "acp",
    "--session", sessionKey,
    "--reset-session",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Log stderr for debugging but don't treat it as a hard failure.
  child.stderr?.on("data", (chunk: Buffer) => {
    console.error(`[ACP stderr] ${chunk.toString().trim()}`);
  });

  // Track whether the child exited early (before we got a response).
  let childExitCode: number | null = null;
  let childExited = false;
  const childClosePromise = new Promise<void>((resolve) => {
    child.on("close", (code) => {
      childExitCode = code;
      childExited = true;
      resolve();
    });
  });

  // 2. Build the ACP stream from the child's stdio.
  //    ndJsonStream(writable, readable): writable = what we write TO (stdin),
  //    readable = what we read FROM (stdout).
  const writableWeb = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const readableWeb = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(writableWeb, readableWeb);

  // 3. Accumulate response text from session/update notifications.
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
      // Auto-approve for internal pipeline calls.
      // Pick the first "allow_once" option; fall back to the first option.
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

  // 4. Explicit 120-second timeout.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("ACP prompt timed out after 120 seconds"));
    }, 120_000);
  });

  try {
    const result = await Promise.race([
      (async () => {
        // 5. Protocol handshake.
        await connection.initialize({ protocolVersion: PROTOCOL_VERSION });

        // 6. Create a session.
        const session = await connection.newSession({
          cwd: process.cwd(),
          mcpServers: [],
        });

        // 7. Send the prompt — travels over stdio, no ARG_MAX.
        await connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text" as const, text: prompt }],
        });

        return responseText.trim();
      })(),
      timeoutPromise,
      // Fail fast if the child exits with an error before we get a response.
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
    clearTimeout(timeoutHandle);
    if (!childExited) {
      child.kill("SIGTERM");
    }
  }
}
