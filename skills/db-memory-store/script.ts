import postgres from "npm:postgres";

const OPENAI_BASE_URL = "http://10.51.51.145:1234/v1";
const DB_URL = "postgres://openclaw:6599@localhost:5432/memorydb";

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${OPENAI_BASE_URL}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, model: "text-embedding-nomic-embed-text-v2-moe" }), 
  });
  const data = await res.json();
  return data.data[0].embedding;
}

async function storeMemory(content: string) {
  const embedding = await getEmbedding(content);
  const sql = postgres(DB_URL);
  
  // Generate SHA-256 hash for deduplication
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const contentHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  try {
    // Insert into the new multi-tenant schema
    await sql`
      INSERT INTO memory_semantic (
        agent_id, 
        content, 
        content_hash, 
        embedding, 
        embedding_model
      )
      VALUES (
        'openclaw-proto-1', -- Hardcoded agent_id for the prototype
        ${content}, 
        ${contentHash}, 
        ${JSON.stringify(embedding)},
        'text-embedding-nomic-embed-text-v2-moe'
      )
      ON CONFLICT (agent_id, content_hash) DO NOTHING;
    `;
    console.log("Memory stored successfully in memory_semantic.");
  } finally {
    await sql.end();
  }
}

// Accept input from the command line arguments
const input = Deno.args.join(" ");
if (input) storeMemory(input);
