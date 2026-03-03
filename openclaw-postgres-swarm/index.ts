// =============================================================================
// RE-EXPORTS — Single entry point for downstream consumers
// =============================================================================

export { sql, LM_STUDIO_URL, DB_URL, AGENT_ID, EMBEDDING_MODEL, getEmbedding, hashContent } from "./db.js";
export { searchPostgres, logEpisodicMemory, fetchPersonaContext, fetchDynamicTools } from "./memoryService.js";

// =============================================================================
// OPENCLAW PLUGIN HOOKS
// =============================================================================

/**
 * Called when a new user message arrives.
 * Responsible for: RAG context injection, persona loading, dynamic tool loading.
 */
export async function onMessage(payload: any): Promise<any> {
  console.log("[HOOK] onMessage triggered");
  // TODO: Wire up RAG injection, persona, and dynamic tool loading
  return payload;
}

/**
 * Called after the model generates a response.
 * Responsible for: Episodic memory logging, tool call observation.
 */
export async function onResponse(payload: any): Promise<void> {
  console.log("[HOOK] onResponse triggered");
  // TODO: Wire up episodic logging and tool call observation
}

/**
 * Called on heartbeat tick.
 * Responsible for: Sleep cycle consolidation, background maintenance.
 */
export async function onHeartbeat(): Promise<void> {
  console.log("[HOOK] onHeartbeat triggered");
  // TODO: Wire up sleep cycle and memory consolidation
}

// =============================================================================
// STANDALONE ENTRY POINT (for testing)
// =============================================================================

import { sql, DB_URL, LM_STUDIO_URL, AGENT_ID, EMBEDDING_MODEL } from "./db.js";

if (require.main === module) {
  console.log("=== openclaw-postgres-swarm plugin loaded ===");
  console.log(`  DB:     ${DB_URL}`);
  console.log(`  LM:     ${LM_STUDIO_URL}`);
  console.log(`  Agent:  ${AGENT_ID}`);
  console.log(`  Model:  ${EMBEDDING_MODEL}`);
  console.log("Hooks exported: onMessage, onResponse, onHeartbeat");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await sql.end();
    process.exit(0);
  });
}
