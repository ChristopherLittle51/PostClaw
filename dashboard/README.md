# PostClaw Dashboard Module

## Overview

The PostClaw Dashboard is an optional, lightweight web interface that provides a graphical front-end for managing your agent's PostgreSQL database. Instead of writing raw SQL queries to inspect the agent's state, developers and users can use this dashboard to visualize semantic memories, edit persona traits, and manually trigger maintenance scripts.

The dashboard runs as a standalone Express-style Node.js HTTP server. It relies on a Single Page Application (SPA) architecture, using `@ambientcss` for styling, and communicates with the underlying PostClaw abstractions via a robust REST API.

---

## Running the Dashboard

You can instantiate the dashboard locally via the OpenClaw command-line interface. The server must be able to connect to the PostgreSQL instance defined in your `openclaw.json` configuration.

```bash
# Start the dashboard on the default port (3333)
openclaw postclaw dashboard

# Start the dashboard on a custom port and bind address
openclaw postclaw dashboard --port 8080 --bind 0.0.0.0
```

### Configuration Flags

* `--port <number>`: Specifies the TCP port the HTTP server binds to (default is `3333`).
* `--bind <address>`: Specifies the network interface. Use `127.0.0.1` (localhost) to restrict access to your current machine. Use `0.0.0.0` to expose the dashboard to your local network.

> **Security Warning:** The dashboard currently implements **no authentication**. Binding to `0.0.0.0` on a public or untrusted network will expose your agent's memory database to unauthorized access. It is highly recommended to run this only on `127.0.0.1`.

---

## Key Features

### 1. Memory Management

The dashboard provides a paginated view of **Semantic** (long-term) memories. Users can manually curate the agent's database by editing memory content, adjusting the memory's assigned category or tier, or hard-deleting irrelevant entries that the automated garbage collection missed.

### 2. Persona Configuration

Agents using PostClaw rely on dynamic persona traits injected into their context window. The dashboard features a dedicated Persona tab where you can view all active traits, their vector representations, and their "always active" status.

### 3. Knowledge Graph Visualization

The system tracks relationships across memories using the `entity_edges` table. The dashboard includes tools to visualize these directed relationships, showing how "Memory A" contextually supports or contradicts "Memory B."

### 4. Administrative Controls

Rather than waiting for the automated timer, users can execute the `sleep_cycle` maintenance routines directly from the dashboard UI. This forces the agent to immediately consolidate recent episodic logs and prune stale semantic entries.

---

## Server Architecture

The dashboard code is organized into three primary layers:

1. **Server Initialization (`server.ts`):**
   Handles HTTP server creation, TCP port binding, static file serving serving from `/public`, and fallback routing for the SPA index.
2. **API Router (`router.ts` & `/routes`):**
   Defines the REST API endpoints (`/api/personas`, `/api/memories`, `/api/graph`, `/api/scripts`). Route handlers validate incoming requests and map them directly into executions of the core `memoryService.ts` and `personaService.ts` libraries.
3. **Frontend SPA (`/public`):**
   Contains the static HTML, CSS, and Vanilla JavaScript (`app.js`) utilized by the browser.

---

## Troubleshooting

### EADDRINUSE: port is already in use

This indicates another application (or an improperly closed instance of the dashboard) is already listening on your target port.

* **Fix:** Manually kill the outstanding Node.js process using the port, or supply a different port via `openclaw postclaw dashboard --port 4000`.

### Database Connection Refused / 500 API Errors

If the dashboard frontend loads but displays no data or throws 500 Internal Server Errors locally, the backend router cannot reach PostgreSQL.

* **Fix:** Verify that your PostgreSQL service is actively running on your host machine. Check your `openclaw.json` to ensure the `dbUrl` parameter points to the correct, authenticated database instance.

### Missing CSS or Vendor Files

If the dashboard UI appears entirely unstyled, the static router failed to locate the `@ambientcss` package.

* **Fix:** Ensure you have fully run `npm install` within the PostClaw plugin directory, as the dashboard serves these dependencies directly from the `node_modules` folder.

### Persona Updates Fail Meaninglessly (Browser Console: 500)

When editing a persona's content in the dashboard, the backend route (`routes/personas.ts`) immediately requests a new vector embedding for the updated text. If your LLM embedding server (e.g., LM Studio/Ollama) has crashed or timed out, the dashboard's API request will fail with a 500 Internal Server Error.

* **Fix:** Ensure your external embedding provider is running and reachable at the REST endpoint defined in your OpenClaw configuration.
