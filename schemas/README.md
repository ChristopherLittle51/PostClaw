# PostClaw Schemas Validation

## Overview

The `schemas/` directory, centered around `validation.ts`, acts as the data bodyguard for the entire PostClaw architecture.

When dealing with artificial intelligence, outputs can be unpredictable. An LLM might hallucinate a new category of memory, or forget to include a required ID when trying to update a fact. To prevent these AI errors from crashing the database or corrupting your agent's memory, PostClaw uses **Zod**, a TypeScript-first schema validation library.

---

## 1. Database Row Validation

Before PostClaw trusts data coming from PostgreSQL, it runs it through a Zod schema to guarantee the shape and types.

* **`MemorySemanticRow` & `EpisodicRow`:** Ensures that every memory fetched from the database has a valid UUID (not just a random string), a proper JavaScript `Date` object for timestamps, and an authorized category (e.g., `core`, `concept`, `human`).
* **Why it matters:** This prevents runtime `undefined` errors if you manually alter the database outside of the plugin and accidentally create a malformed row.

## 2. Agent Tool Guardrails

OpenClaw allows agents to call "Tools" (functions) to perform actions like saving or modifying a memory. The schemas in this file strictly govern what the agent is allowed to pass to those tools.

* **`MemoryStoreSchema`:** When the agent calls `memory_store`, Zod enforces that the `content` is a string, and that the `tier` parameter is explicitly either `"permanent"`, `"session"`, or `"temporary"`. If the AI tries to use a tier like `"forever"`, the schema rejects it and returns a clean error to the LLM, prompting it to try again with the correct format.
* **`MemoryUpdateSchema`:** Enforces that the agent provides a valid UUID when attempting to supersede an old memory.

## 3. Sleep Cycle JSON Parsing

During the automated background maintenance (the sleep cycle), PostClaw asks the LLM to process thousands of words and return a compressed, structured JSON object outlining duplicate memories or new facts.

* **`EpisodicSummarySchema` & `ConsolidationEvaluationSchema`:** These schemas define the exact JSON format the LLM must return. If the LLM returns an array instead of an object, or forgets to include an `isDuplicate` boolean flag, Zod catches the error instantly.
* **Why it matters:** This is the most common point of failure for smaller LLMs. Without strict validation, bad JSON would break the parsing logic and silently fail to consolidate memories.

---

## Troubleshooting Guide

### "Validation failed" or "ZodError" in Agent Logs

If you see a `ZodError` printed in your terminal while the agent is "thinking," it means the agent attempted to use a memory tool incorrectly.

* **Fix:** You generally don't need to do anything. OpenClaw automatically feeds the Zod error back to the LLM, which acts as a correction mechanism, teaching the AI how to fix its own formatting error on the next attempt. However, if the agent persistently fails over multiple turns, your primary LLM might be too weak to follow complex JSON instructions.

### Sleep Cycle: "Failed to parse LLM response for batch"

The background sleep script (e.g., Phase I or Phase IV) skipped a batch of memories because the LLM failed to match the `EpisodicSummarySchema`.

* **Fix:** The LLM you are using (e.g., through Ollama or LM Studio) likely included conversational text (like "Here is the JSON you requested:") or markdown formatting (` ```json ` tags) that breaks raw JSON parsing before Zod can even validate it. Switch to a stronger model (like Llama 3 or Qwen) or ensure your LLM prompt template enforces strict JSON-only outputs.

### UUID Validation Failures

If the dashboard or manual scripts throw an error about an invalid UUID, a function received a plain string instead of a true Database ID.

* **Fix:** Ensure any manual IDs you provide (such as when testing API routes or using the CLI) are formatted as standard 36-character `v4` UUIDs (e.g., `123e4567-e89b-12d3-a456-426614174000`). Zod intrinsically blocks unstructured strings.

### "Invalid Enum Value" during Memory Storage

If the agent attempts to save a new memory and the terminal throws an error stating `Received: 'critical' - Expected: 'permanent' | 'session' | 'temporary'`.

* **Fix:** The LLM hallucinated a memory tier or category that doesn't strictly exist within the plugin's Zod definitions. The agent must stick strictly to the enumerated values defined in `MemoryStoreSchema`. OpenClaw automatically reflects this error back to the LLM so it can correct its mistake on a retry.

### Date Object Parsing Errors

When the plugin pulls data from the PostgreSQL `memory_episodic` table using the `EpisodicRow` schema, Zod expects valid JavaScript Date objects for timestamps, not raw ISO strings.

* **Fix:** If you are building custom manual scripts interacting directly with the database rows, ensure you are utilizing `postgres.js`'s built-in date parsing or manually hydrating your JSON returns into Date objects before passing them into the Zod validator.
