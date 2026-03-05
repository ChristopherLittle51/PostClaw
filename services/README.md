# PostClaw Services Layer

## Overview

The `services/` directory is the core operational layer of the PostClaw architecture. These TypeScript files serve as the bridge between OpenClaw's event hooks, the underlying PostgreSQL database, and your external LLM inference endpoints.

This module abstracts away the complex raw SQL queries and vector mathematical operations, providing clean, predictable functions for storing memories, generating embeddings, and retrieving context for your agent.

---

## Core Services

### 1. Database & Embeddings (`db.ts`)

This module manages the connection pool to PostgreSQL using the lightweight `postgres.js` library. It also handles the translation of plain text into mathematical vectors.

* **Purpose:** Handles database connectivity and embedding logic securely.
* **Key Function:** `getEmbedding(text: string)`. This function takes a string (e.g., a memory or persona rule) and calls your configured LLM embedding endpoint (such as LM Studio or Ollama). It returns a normalized array of floating-point numbers (a vector) and generates a SHA-256 hash mathematically representing the content to prevent duplicates.

### 2. Global Configuration (`config.ts`)

PostClaw relies on custom settings defined inside the PostgreSQL `plugin_config` table (editable via the Dashboard), while core connection details (`dbUrl` and embedding models) are loaded from the user's `~/.openclaw/openclaw.json` file.

* **Purpose:** Loads, validates, and provides sensible defaults for your configuration.
* **Key Elements:** Extracts settings such as the database URL (`dbUrl`), the frequency of background maintenance (`sleepIntervalHours`), and the thresholds for vector similarity matches.

### 3. Inference Mediation (`llm.ts`)

Instead of duplicating HTTP request logic every time PostClaw needs to think (such as during the background sleep cycle), it leverages OpenClaw's native model routing.

* **Purpose:** Routes prompt instructions cleanly to the agent's primary LLM.
* **Key Function:** `callLLMviaAgent()`. This abstraction ensures that whichever model you have configured inside OpenClaw (OpenAI, Anthropic, local Llama) is systematically used for memory consolidation and persona extraction.

### 4. Semantic Memory Operations (`memoryService.ts`)

This is the most critical file in the plugin, orchestrating exactly how the agent remembers, forgets, and retrieves facts.

* **Purpose:** Manages the CRUD (Create, Read, Update, Delete) lifecycle of all memories.
* **Key Functions:**
  * **`searchPostgres` (RAG):** Implements Retrieval-Augmented Generation. It takes the user's current prompt, turns it into a vector, and searches the `memory_semantic` database for facts that are mathematically similar. It then traverses the `entity_edges` table (a Knowledge Graph) to pull in related context.
  * **`storeMemory`:** Generates embeddings for new facts and saves them to the database.
  * **`updateMemory`:** Creates a new, corrected memory and marks the older memory as `superseded_by` the new one, creating an auditable history of exactly how a fact evolved.
  * **`logEpisodicMemory`:** Automatically records every single interaction (user prompt or tool call) sequentially into the `memory_episodic` table as short-term context.

### 5. Identity Context (`personaService.ts`)

This service manages the specific rules injected into the agent's system prompt.

* **Purpose:** Handles the CRUD lifecycle of persona traits.
* **Key Elements:** Separates traits into "Core" (always injected) and "Situational" rules. Situational rules are dynamically injected during a conversation purely based on mathematical semantic similarity to the user's prompt.

---

## Troubleshooting

### Connection Refused (`db.ts`)

If functions like `storeMemory` are failing with timeouts or `ECONNRESET`, verify your PostgreSQL service is actively running. Check your connection string (`dbUrl`) inside the `openclaw.json` configuration file to ensure you have provided the correct username, password, and port.

### Embedding Timeouts (`db.ts`)

If the database connects successfully, but operations freeze or timeout while trying to generate vectors, check your LLM hosting application (LM Studio, Ollama). Ensure the server is actively running and that the configured API endpoint (e.g., `http://127.0.0.1:1234/v1`) in OpenClaw matches the active host.

### Empty RAG Results (`memoryService.ts`)

If the agent claims it doesn't remember anything despite memories existing in the database, the `searchPostgres` function might be hitting a strict RLS (Row-Level Security) boundary or your agent's current embedding model is generating vectors with entirely different dimensionalities than the ones originally stored (e.g., mixing a 768-dimension `nomic` model with a 1024-dimension `mxbai` model).

### Knowledge Graph Linking Errors (Violates Foreign Key Constraint)

If an agent or script calls `linkMemories()` and you receive a database Foreign Key Constraint error regarding the `entity_edges` table.

* **Fix:** The agent attempted to link two memory UUIDs, but one of those memories was recently hard-deleted by the sleep cycle or user before the edge could be formed. Edges can only be drawn between facts that actively exist in `memory_semantic` or `agent_persona`.

### Prompt Flooding During Persona Injection

If the agent begins repeating instructions endlessly or seems overly constrained, it may be pulling in too many situational persona rules at a high similarity rate.

* **Fix:** Check your global configuration array `situationalLimit` value (which defaults to 5). Lowering this number will force the `personaService` to inject fewer contextual rules per turn, preserving your primary LLM's attention span.
