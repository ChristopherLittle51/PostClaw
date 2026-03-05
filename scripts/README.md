# PostClaw Scripts Directory

## Overview

The `scripts/` directory houses the core utility executables for the PostClaw memory plugin. These TypeScript files are responsible for critical lifecycle events: setting up the database, defining agent personas from markdown files, and running the background maintenance tasks that organize the agent's memory.

Instead of writing custom management tools, you can invoke these scripts directly through the OpenClaw Command Line Interface (CLI) to manage your agent's state.

---

## 1. Database Initialization (`setup-db.ts`)

Before PostClaw can store any memories, the PostgreSQL database must be properly configured. This script automates the installation of required extensions, creation of service users, and generation of the tables and Row-Level Security (RLS) policies.

### Usage

Run this script once during your initial plugin setup.

```bash
# Basic setup (will prompt for an admin connection url)
openclaw postclaw setup

# Non-interactive setup providing the URL directly
openclaw postclaw setup --admin-url postgres://<admin_user>:<password>@localhost/postgres
```

### What it does

1. Connects to the database using the provided administrator credentials.
2. Creates the `vector` (for semantic search) and `pgcrypto` (for secure UUIDs) extensions.
3. Provisions a dedicated `openclaw` database user with restricted permissions.
4. Generates the necessary tables (`agents`, `memory_semantic`, `memory_episodic`, `entity_edges`, `agent_persona`).
5. Enforces strict RLS policies, ensuring that Agent A can never query or corrupt Agent B's data when running in a multi-agent environment.

---

## 2. Autonomous Maintenance (`sleep_cycle.ts`)

PostClaw acts as an automated memory manager. To prevent the database from growing indefinitely with redundant chats or useless conversational filler, it relies on this background job. By default, it runs automatically every 6 hours (configurable via the `startService` options in `index.ts`).

### Usage

You can force the sleep cycle to run immediately:

```bash
openclaw postclaw sleep
```

### Configuration & Thresholds

The heuristic variables determining what is "useless" or "redundant" are strictly managed by the `plugin_config` database table (which you can modify through the Dashboard's **Config** tab). These include targets like:

* `duplicateSimilarityThreshold` (e.g., `0.80`)
* `lowValueAgeDays` (e.g., `7`)
* `linkSimilarityMin` (e.g., `0.65`)

### What it does

The script executes four sequential phases:

1. **Consolidation:** The script gathers all recent short-term logs ("episodic" memories). It sends these rough transcripts to the agent's primary LLM, asking it to extract durable facts and concepts.
2. **Deduplication:** The script performs a mathematical cosine similarity search across all existing semantic memories. If two memories represent the exact same concept (e.g., "User likes coffee" and "User's favorite drink is coffee", with >0.80 similarity), it merges them and archives the redundant, older version.
3. **Low-Value Cleanup:** The script scans the database for memories that haven't been accessed in a long time and have a low confidence score. If they fall below the retention threshold, they are hard-deleted or archived.
4. **Link Discovery:** The script analyzes the remaining semantic memories and asks the LLM to identify logical connections (e.g., Memory A supports Memory B). These connections are saved in the `entity_edges` table to build a navigable Knowledge Graph.

---

## 3. Persona Bootstrapping (`bootstrap_persona.ts`)

For an agent to behave consistently, its personality traits must be injected into its system prompt dynamically. This script ingests standard Markdown (`.md`) files authored by the user and parses them into discrete, vector-encoded rules in the database.

### Usage

```bash
# Path to your custom markdown definition
openclaw postclaw persona ./path/to/my-agent-definition.md
```

### What it does

The script sends your markdown file to the LLM, instructing it to break the document down into specific JSON rules (e.g., identifying Core directives versus Situational preferences). It then generates embeddings for each rule and saves them into the `agent_persona` table. The plugin retrieves these rules in real-time during conversations based on the user's prompt.

---

## Troubleshooting Guide

### Missing PostgreSQL Extensions (`setup-db.ts`)

If the database setup fails with `could not open extension control file "pgvector"`, your PostgreSQL installation lacks the required mathematical vector extension.

* **Fix:** Install pgvector using your system's package manager (e.g., `sudo apt install postgresql-[VERSION]-pgvector` on Linux, or `brew install pgvector` on macOS).

### Failed to Parse LLM Response (`sleep_cycle.ts`)

The sleep cycle relies on strict JSON responses from your configured LLM (e.g., LM Studio/Ollama). If the script throws Zod validation errors or generic parsing failures, the LLM failed to follow the structural instructions.

* **Fix:** Ensure you are using a capable, modern LLM (like Llama 3 or Qwen) as your primary model. Smaller models mathematically struggle to consistently output pure JSON arrays without wrapping them in markdown text.

### Connection Refused or Sleep Cycle Never Runs

If the background script is failing to start or cannot process vectors:

* **Fix:** Check your `openclaw.json` configuration. Ensure the `dbUrl` is correct and your PostgreSQL service is running natively. If the background loop is failing to trigger, ensure the main OpenClaw agent instance is actively running.

### Persona Bootstrapper Creates No Rules (`bootstrap_persona.ts`)

If you run the script and it completes instantly without saving any rules into the database, it means the LLM evaluated the markdown file and returned an empty array `[]`.

* **Fix:** Ensure the markdown file is not completely empty and contains declarative facts. Additionally, guarantee your primary LLM is capable enough to understand the schema extraction prompt—very small models sometimes return empty arrays if they struggle to classify traits.

### Sleep Cycle: Aggressive Memory Merging

If the agent begins combining wildly dissimilar memories during the deduplication phase.

* **Fix:** The string similarity threshold configuring the `pgvector` distance equation is likely too low. Check the Dashboard's **Config** tab and ensure the `Dedup Similarity` (`sleep.duplicateSimilarityThreshold`) is explicitly set to `0.80` or higher to prevent sloppy mathematical merging.
