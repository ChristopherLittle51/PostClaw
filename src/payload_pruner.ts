// src/payload_pruner.ts

export function prunePayload(body: any): any {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  // 1. Analyze the user's latest message to determine what tools are actually needed
  const lastUserIndex = body.messages.findLastIndex((m: any) => m.role === "user");
  let userText = "";
  if (lastUserIndex !== -1) {
    const lastMessage = body.messages[lastUserIndex];
    if (typeof lastMessage.content === "string") {
      userText = lastMessage.content.toLowerCase();
    } else if (Array.isArray(lastMessage.content)) {
      userText = lastMessage.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join(" ")
        .toLowerCase();
    }
  }

  // 2. Prune the System Prompt (Markdown Bloat)
  const systemIndex = body.messages.findIndex((m: any) => m.role === "system");
  if (systemIndex !== -1 && typeof body.messages[systemIndex].content === "string") {
    let sysPrompt = body.messages[systemIndex].content;

    // Remove the massive XML <available_skills> block
    sysPrompt = sysPrompt.replace(/<available_skills>[\s\S]*?<\/available_skills>\n?/g, "");
    
    // Remove the heavy group chat and heartbeat instructions if they aren't relevant right now
    if (!userText.includes("discord") && !userText.includes("heartbeat")) {
      sysPrompt = sysPrompt.replace(/## Group Chats[\s\S]*?## Tools/g, "## Tools\n");
      sysPrompt = sysPrompt.replace(/## 💓 Heartbeats - Be Proactive![\s\S]*?## Make It Yours/g, "## Make It Yours\n");
    }

    body.messages[systemIndex].content = sysPrompt;
  }

  // 3. Just-In-Time (JIT) Tool Filtering
  if (body.tools && Array.isArray(body.tools)) {
    // These are the lightweight, essential local tools
    const coreTools = ["read", "write", "edit", "exec", "process", "session_status"];
    
    const activeTools = [...coreTools];

    // Dynamically add heavy tools only if the user's prompt suggests they need them
    if (userText.includes("search") || userText.includes("web") || userText.includes("google")) {
      activeTools.push("web_search", "web_fetch");
    }
    if (userText.includes("browser") || userText.includes("chrome") || userText.includes("navigate")) {
      activeTools.push("browser");
    }
    if (userText.includes("message") || userText.includes("discord") || userText.includes("telegram")) {
      activeTools.push("message");
    }
    if (userText.includes("canvas") || userText.includes("draw")) {
      activeTools.push("canvas");
    }

    // Filter the tools array
    const originalToolCount = body.tools.length;
    body.tools = body.tools.filter((t: any) => activeTools.includes(t.function.name));
    
    console.log(`[PRUNER] Reduced tool schema from ${originalToolCount} to ${body.tools.length} tools.`);
  }

  // (Phase 2 placeholder: We will inject native db-memory-store JSON schema here later)

  return body;
}