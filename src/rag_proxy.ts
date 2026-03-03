import postgres from "npm:postgres";
// NEW: Import the payload pruner
import { prunePayload } from "./payload_pruner.ts"; 

const LM_STUDIO_URL = "http://10.51.51.145:1234";
const DB_URL = "postgres://openclaw:6599@localhost:5432/memorydb";
const AGENT_ID = "openclaw-proto-1";

const sql = postgres(DB_URL);

const processedEvents = new Set<string>();

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${LM_STUDIO_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, model: "text-embedding-nomic-embed-text-v2-moe" }),
  });
  const data = await res.json();
  const embedding = data.data[0].embedding;
  
  console.log(`\n[DEBUG] Generated Embedding for query: "${text.substring(0, 50)}..."`);
  console.log(`[DEBUG] Vector Dimensions: ${embedding.length}`);
  
  return embedding;
}

async function searchPostgres(query: string): Promise<string | null> {
  const embedding = await getEmbedding(query);
  let retrievedContext: string | null = null;
  
  try {
    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
      
      const results = await tx`
        WITH vector_search AS (
          SELECT id, content, 1 - (embedding <=> ${JSON.stringify(embedding)}) AS vector_score
          FROM memory_semantic
          WHERE is_archived = false
          ORDER BY embedding <=> ${JSON.stringify(embedding)} LIMIT 5
        ),
        text_search AS (
          SELECT id, content, ts_rank(fts_vector, websearch_to_tsquery('simple', ${query})) AS text_score
          FROM memory_semantic 
          WHERE is_archived = false AND fts_vector @@ websearch_to_tsquery('simple', ${query})
        )
        SELECT COALESCE(v.content, t.content) as content,
               (COALESCE(v.vector_score, 0) * 0.7) + (COALESCE(t.text_score, 0) * 0.3) AS combined_score
        FROM vector_search v
        FULL OUTER JOIN text_search t ON v.id = t.id
        ORDER BY combined_score DESC LIMIT 3;
      `;

      if (results.length > 0) {
        retrievedContext = results.map((r: any) => r.content).join("\n");
        console.log(`\n[DEBUG] --- Retrieved Database Memories ---`);
        results.forEach((row: any, index: number) => {
          console.log(`Rank ${index + 1} (Score: ${row.combined_score.toFixed(4)}): ${row.content}`);
        });
        console.log(`[DEBUG] -----------------------------------`);
      } else {
        console.log(`[DEBUG] No relevant memories retrieved from database.`);
      }
    });
  } catch (err) {
    console.error("[DEBUG] Database search failed:", err);
  }

  return retrievedContext;
}

async function fetchPersonaContext(embedding: number[]): Promise<string | null> {
  let personaContext: string | null = null;
  
  try {
    await sql.begin(async (tx: any) => {
      // Set RLS scope for the query
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
      
      const results = await tx`
        WITH core_persona AS (
          SELECT category, content, 1.0 AS relevance_score
          FROM agent_persona
          WHERE is_always_active = true
        ),
        situational_persona AS (
          SELECT category, content, 1 - (embedding <=> ${JSON.stringify(embedding)}) AS relevance_score
          FROM agent_persona
          WHERE is_always_active = false
          ORDER BY embedding <=> ${JSON.stringify(embedding)}
          LIMIT 3
        )
        SELECT * FROM core_persona
        UNION ALL
        SELECT * FROM situational_persona
        ORDER BY relevance_score DESC;
      `;

      if (results.length > 0) {
        // Format the rules into a clean markdown block
        personaContext = results.map((r: any) => `* **[${r.category}]**: ${r.content}`).join("\n");
        console.log(`\n[DEBUG] --- Loaded ${results.length} Persona Rules from Database ---`);
      }
    });
  } catch (err) {
    console.error("[DEBUG] Persona fetch failed:", err);
  }

  return personaContext;
}

async function fetchDynamicTools(embedding: number[]): Promise<any[]> {
  let dynamicTools: any[] = [];
  try {
    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
      
      // Lowered the threshold from 0.50 to 0.35
      const results = await tx`
        SELECT tool_name, context_data, 1 - (embedding <=> ${JSON.stringify(embedding)}) AS similarity
        FROM context_environment
        WHERE 1 - (embedding <=> ${JSON.stringify(embedding)}) > 0.35
        ORDER BY similarity DESC
        LIMIT 3;
      `;
      
      if (results.length > 0) {
        dynamicTools = results.map((r: any) => JSON.parse(r.context_data));
        console.log(`\n[DEBUG] 🔧 Dynamically loaded tools from DB: ${results.map((r: any) => r.tool_name).join(', ')}`);
      }
    });
  } catch (err) {
    console.error("[DEBUG] Failed to fetch dynamic tools:", err);
  }
  return dynamicTools;
}

async function logEpisodicMemory(text: string, embedding: number[], eventType: string = 'user_prompt') {
  // 1. In-Memory Debounce Check
  if (processedEvents.has(text)) return;
  
  // 2. Add to cache and prevent memory leaks by capping size
  processedEvents.add(text);
  if (processedEvents.size > 1000) processedEvents.clear();

  try {
    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
      
      await tx`
        INSERT INTO memory_episodic (
          agent_id, session_id, event_summary, event_type, embedding, embedding_model
        ) VALUES (
          ${AGENT_ID}, 'active-session', ${text}, ${eventType}, ${JSON.stringify(embedding)}, 'nomic-embed-text-v2-moe'
        )
      `;
    });
    console.log(`\n[OBSERVER] 📝 Logged episodic event (${eventType}) to database.`);
  } catch (err) {
    console.error("[OBSERVER] Failed to log episodic memory:", err);
  }
}

async function logEpisodicToolCalls(messages: any[]) {
  try {
    const lastAssistantIndex = messages.findLastIndex((m: any) => 
      m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0
    );
    
    if (lastAssistantIndex !== -1) {
      const assistantMessage = messages[lastAssistantIndex];
      
      for (const toolCall of assistantMessage.tool_calls) {
        const toolCallId = toolCall.id || `fallback-${toolCall.function.name}-${toolCall.function.arguments.substring(0, 20)}`;
        
        // 1. In-Memory Debounce Check
        if (processedEvents.has(toolCallId)) continue;
        
        // 2. Add to cache
        processedEvents.add(toolCallId);
        
        const toolName = toolCall.function.name;
        const toolArgs = toolCall.function.arguments;
        const summary = `Agent executed tool: ${toolName} with arguments: ${toolArgs}`;
        
        // Only generate the embedding IF it passes the cache check
        const embedding = await getEmbedding(summary);
        
        await sql.begin(async (tx: any) => {
          await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
          await tx`
            INSERT INTO memory_episodic (
              agent_id, session_id, event_summary, event_type, embedding, embedding_model, metadata
            ) VALUES (
              ${AGENT_ID}, 'active-session', ${summary}, 'tool_execution', ${JSON.stringify(embedding)}, 'nomic-embed-text-v2-moe', ${JSON.stringify({ tool_call_id: toolCallId, tool_name: toolName })}
            )
          `;
        });
        console.log(`\n[OBSERVER] 🛠️  Logged tool execution (${toolName}) to database.`);
      }
    }
  } catch (err) {
    console.error("[OBSERVER] Failed to log episodic tool calls:", err);
  }
}

Deno.serve({ port: 8000, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);
  
  if (req.method === "POST" && url.pathname.includes("/chat/completions")) {
    let body = await req.json();
    
    // ====================================================================
    // NEW: Prune the payload before doing anything else
    body = prunePayload(body);
    // ====================================================================

    const lastUserIndex = body.messages.findLastIndex((m: any) => m.role === "user");
    
    if (lastUserIndex !== -1) {
      const lastMessage = body.messages[lastUserIndex];
      let userText = "";

      if (typeof lastMessage.content === "string") {
        userText = lastMessage.content;
      } else if (Array.isArray(lastMessage.content)) {
        userText = lastMessage.content
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join(" ");
      }

      if (userText.trim() !== "") {
        console.log(`\n==================================================`);
        console.log(`[REQUEST] Intercepted user message: "${userText}"`);
        
        // Strip the [Day YYYY-MM-DD HH:MM UTC] prefix for a purer semantic vector
        const cleanText = userText.replace(/^\[.*?\]\s*/, "");
        
        // 1. Generate the embedding using the CLEAN text
        const embedding = await getEmbedding(cleanText);
        
        // ====================================================================
        // NEW: SILENT OBSERVER
        // ====================================================================
        const isHeartbeat = userText.toLowerCase().includes("heartbeat") || userText.toLowerCase().includes("cron");
        
        if (!isHeartbeat) {
          // Fire-and-forget logging for the User's prompt
          logEpisodicMemory(userText, embedding, "user_prompt");
        }

        // Fire-and-forget scanning for the Assistant's recent tool calls
        logEpisodicToolCalls(body.messages);
        // ====================================================================
        
        // 2. Fetch Memories, Persona, and Tools concurrently
        const [memoryContext, personaContext, dynamicTools] = await Promise.all([
          searchPostgres(userText), 
          fetchPersonaContext(embedding),
          fetchDynamicTools(embedding) // NEW
        ]);
        
        // 3. Inject Situational Memories into the User Message
        if (memoryContext) {
          console.log("\n[INJECTION] Injecting memory context directly into the user's prompt...");
          const injectionString = `[SYSTEM RAG CONTEXT]\nThe following historical memories were retrieved from the database. Use them to help answer the user's query if they are relevant:\n\n${memoryContext}\n\n[END CONTEXT]\n\n`;

          if (typeof lastMessage.content === "string") {
            body.messages[lastUserIndex].content = injectionString + lastMessage.content;
          } else if (Array.isArray(lastMessage.content)) {
            body.messages[lastUserIndex].content.unshift({ type: "text", text: injectionString });
          }
        }

        // 4. Inject the Identity into the System Prompt
        if (personaContext) {
          const systemIndex = body.messages.findIndex((m: any) => m.role === "system");
          if (systemIndex !== -1) {
             console.log("\n[INJECTION] Injecting dynamic database persona into the system prompt...");
             const identityString = `\n\n## Dynamic Database Persona\nThe following core operational rules were loaded from your database:\n${personaContext}\n`;
             body.messages[systemIndex].content += identityString;
          }
        }

        // NEW: Inject Dynamic Tools
        if (dynamicTools.length > 0 && body.tools) {
           body.tools.push(...dynamicTools);
        }
      }
    }

    try {
      await Deno.mkdir("debug_logs", { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logFile = `debug_logs/prompt_dump_${timestamp}.json`;
      await Deno.writeTextFile(logFile, JSON.stringify(body, null, 2));
      console.log(`[DEBUG] Successfully dumped pruned prompt payload to: ${logFile}`);
    } catch (e) {
      console.error("[DEBUG] Failed to write prompt debug log:", e);
    }

    return fetch(`${LM_STUDIO_URL}${url.pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...req.headers },
      body: JSON.stringify(body)
    });
  }

  return fetch(`${LM_STUDIO_URL}${url.pathname}${url.search}`, {
    method: req.method,
    headers: req.headers,
    body: req.body
  });
});