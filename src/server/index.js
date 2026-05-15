import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "./env.js";
import { addMessage, createConversation, deleteMessagesAfter, getConversation, getFile, getFiles, getMemory, listConversations, listMessages, updateConversation, updateMessage, upsertMemory } from "./store.js";
import { getDefaultModel, models, resolveModel, streamAssistantResponse } from "./providers.js";
import { saveUploadedFile } from "./uploads.js";
import { buildMemorySnapshot, createEmptyMemory, prepareMessagesForModel, shouldUpdateMemory } from "./memory.js";

await loadEnvFile();

const PORT = Number(process.env.APP_PORT || 4499);
const PUBLIC_DIR = path.resolve("src/client");

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: error.message || "Internal server error" });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Conversation Agent running at http://127.0.0.1:${PORT}`);
});

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(res, 200, {
      defaultModel: getDefaultModel(),
      models,
      hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
      hasOpenRouterKey: Boolean(process.env.OPENROUTER_API_KEY),
      conversations: await listConversations()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/conversations") {
    const body = await readJson(req);
    const conversation = await createConversation({
      title: body.title || "New chat",
      model: body.model || getDefaultModel()
    });
    sendJson(res, 201, { conversation });
    return;
  }

  const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (conversationMatch && req.method === "GET") {
    const conversation = await getConversation(conversationMatch[1]);
    if (!conversation) return sendJson(res, 404, { error: "Conversation not found" });
    sendJson(res, 200, {
      conversation,
      messages: await listMessages(conversation.id),
      files: await listConversationFiles(conversation.id),
      memory: await getConversationMemory(conversation.id)
    });
    return;
  }

  if (conversationMatch && req.method === "PATCH") {
    const body = await readJson(req);
    const patch = {};
    if (typeof body.title === "string") patch.title = body.title.slice(0, 80);
    if (typeof body.model === "string") patch.model = resolveModel(body.model)?.key || getDefaultModel();
    const conversation = await updateConversation(conversationMatch[1], patch);
    if (!conversation) return sendJson(res, 404, { error: "Conversation not found" });
    sendJson(res, 200, { conversation });
    return;
  }

  if (conversationMatch && req.method === "DELETE") {
    const conversation = await updateConversation(conversationMatch[1], { archivedAt: new Date().toISOString() });
    if (!conversation) return sendJson(res, 404, { error: "Conversation not found" });
    sendJson(res, 200, { conversation });
    return;
  }

  const messageMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messageMatch && req.method === "POST") {
    await streamConversationMessage(req, res, messageMatch[1]);
    return;
  }

  const memoryMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/memory$/);
  if (memoryMatch && req.method === "GET") {
    const conversation = await getConversation(memoryMatch[1]);
    if (!conversation) return sendJson(res, 404, { error: "Conversation not found" });
    sendJson(res, 200, { memory: await getConversationMemory(conversation.id) });
    return;
  }

  if (memoryMatch && req.method === "PATCH") {
    const conversation = await getConversation(memoryMatch[1]);
    if (!conversation) return sendJson(res, 404, { error: "Conversation not found" });
    const body = await readJson(req);
    const current = await getConversationMemory(conversation.id);
    const memory = await upsertMemory(conversation.id, sanitizeMemoryPatch(current, body));
    sendJson(res, 200, { memory });
    return;
  }

  const regenerateMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/regenerate$/);
  if (regenerateMatch && req.method === "POST") {
    await regenerateConversationMessage(req, res, regenerateMatch[1]);
    return;
  }

  const branchMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/branch$/);
  if (branchMatch && req.method === "POST") {
    const removedIds = await deleteMessagesAfter(branchMatch[1], branchMatch[2]);
    sendJson(res, 200, { removedIds });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/uploads") {
    const body = await readJson(req, 30 * 1024 * 1024);
    const bytes = Buffer.from(body.data || "", "base64");
    const file = await saveUploadedFile({
      filename: body.filename,
      mimeType: body.mimeType,
      bytes
    });
    sendJson(res, 201, { file });
    return;
  }

  const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
  if (fileMatch && req.method === "GET") {
    const file = await getFile(fileMatch[1]);
    if (!file) return sendJson(res, 404, { error: "File not found" });
    const body = await readFile(file.storagePath);
    res.writeHead(200, {
      "Content-Type": file.mimeType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${sanitizeHeaderFilename(file.filename)}"`,
      "Cache-Control": "private, max-age=3600"
    });
    res.end(body);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function streamConversationMessage(req, res, conversationId) {
  const conversation = await getConversation(conversationId);
  if (!conversation) return sendJson(res, 404, { error: "Conversation not found" });

  const body = await readJson(req);
  const content = String(body.content || "").trim();
  const selectedModels = resolveRequestedModels(body, conversation);
  const model = selectedModels[0];
  const fileIds = Array.isArray(body.fileIds) ? body.fileIds : [];
  if (!content && fileIds.length === 0) return sendJson(res, 400, { error: "Message content or file is required" });

  const files = await getFiles(fileIds);
  await updateConversation(conversationId, {
    model,
    title: conversation.title === "New chat" && content ? createTitle(content) : conversation.title
  });

  const userMessage = await addMessage({
    conversationId,
    role: "user",
    content,
    model,
    files: files.map((file) => file.id),
    turnId: randomUUID()
  });
  const history = await listMessages(conversationId);
  await streamAssistantsForHistory({ req, res, conversationId, models: selectedModels, files, history, userMessage });
}

async function regenerateConversationMessage(req, res, conversationId) {
  const conversation = await getConversation(conversationId);
  if (!conversation) return sendJson(res, 404, { error: "Conversation not found" });

  const body = await readJson(req);
  const messages = await listMessages(conversationId);
  const lastUserIndex = findLastIndex(messages, (message) => message.role === "user");
  const lastUser = lastUserIndex === -1 ? null : messages[lastUserIndex];
  if (!lastUser) return sendJson(res, 400, { error: "No user message to regenerate from" });
  const trailingAssistants = messages.slice(lastUserIndex + 1).filter((message) => message.role === "assistant");
  const selectedModels = resolveRequestedModels(body, conversation, trailingAssistants.map((message) => message.model).filter(Boolean));
  const model = selectedModels[0];

  await deleteMessagesAfter(conversationId, lastUser.id);
  await updateConversation(conversationId, { model });
  const files = await getFiles(lastUser.files || []);
  const history = await listMessages(conversationId);
  await streamAssistantsForHistory({ req, res, conversationId, models: selectedModels, files, history, userMessage: null });
}

async function streamAssistantsForHistory({ req, res, conversationId, models, files, history, userMessage }) {
  const memory = await getConversationMemory(conversationId);
  const modelMessages = prepareMessagesForModel(history, memory);
  const lastHistoryUserIndex = findLastIndex(history, (message) => message.role === "user");
  const turnId = userMessage?.turnId || history[lastHistoryUserIndex]?.turnId || randomUUID();
  const assistantMessages = [];
  for (const [index, model] of models.entries()) {
    assistantMessages.push(await addMessage({
      conversationId,
      role: "assistant",
      content: "",
      model,
      status: "streaming",
      turnId,
      candidateIndex: index
    }));
  }
  const abortController = new AbortController();

  req.on("close", () => abortController.abort());

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  writeEvent(res, "message.started", { userMessage, assistantMessages });

  const streamOne = async (assistantMessage) => {
    let accumulated = "";
    try {
      for await (const event of streamAssistantResponse({ model: assistantMessage.model, messages: modelMessages, files, memory, signal: abortController.signal })) {
        if (event.type === "message.delta") {
          accumulated += event.delta;
          writeEvent(res, event.type, { messageId: assistantMessage.id, delta: event.delta });
        } else if (event.type === "message.completed") {
          await updateMessage(assistantMessage.id, {
            content: accumulated,
            status: "completed",
            providerResponseId: event.providerResponseId,
            usage: event.usage
          });
          writeEvent(res, event.type, { messageId: assistantMessage.id, providerResponseId: event.providerResponseId, usage: event.usage });
        }
      }
    } catch (error) {
      const status = abortController.signal.aborted ? "cancelled" : "failed";
      await updateMessage(assistantMessage.id, {
        content: accumulated,
        status,
        error: error.message
      });
      writeEvent(res, "message.failed", { messageId: assistantMessage.id, status, error: error.message });
    }
  };

  try {
    await Promise.all(assistantMessages.map(streamOne));
    const updatedMemory = await refreshConversationMemory(conversationId, memory);
    if (updatedMemory) writeEvent(res, "memory.updated", { memory: updatedMemory });
  } finally {
    res.end();
  }
}

function findLastIndex(items, predicate) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index], index)) return index;
  }
  return -1;
}

function resolveRequestedModels(body, conversation, fallbackModels = []) {
  const requested = Array.isArray(body.models) && body.models.length
    ? body.models
    : [
        ...fallbackModels,
        body.model,
        conversation.model,
        getDefaultModel()
      ];
  const selected = [];
  for (const value of requested) {
    const model = resolveModel(value)?.key;
    if (!model || selected.includes(model)) continue;
    selected.push(model);
    if (selected.length === 2) break;
  }
  return selected.length ? selected : [getDefaultModel()];
}

async function getConversationMemory(conversationId) {
  return await getMemory(conversationId) || createEmptyMemory(conversationId);
}

async function listConversationFiles(conversationId) {
  const messages = await listMessages(conversationId);
  const ids = [...new Set(messages.flatMap((message) => message.files || []))];
  return getFiles(ids);
}

async function refreshConversationMemory(conversationId, currentMemory) {
  const messages = await listMessages(conversationId);
  if (!shouldUpdateMemory(messages, currentMemory)) return null;
  const nextMemory = buildMemorySnapshot(conversationId, messages, currentMemory);
  return upsertMemory(conversationId, nextMemory);
}

function sanitizeMemoryPatch(current, body) {
  return {
    ...current,
    enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled !== false,
    summary: typeof body.summary === "string" ? body.summary.slice(0, 1800) : current.summary || "",
    facts: sanitizeStringList(body.facts, current.facts, 14),
    decisions: sanitizeStringList(body.decisions, current.decisions, 10),
    openQuestions: sanitizeStringList(body.openQuestions, current.openQuestions, 8),
    topics: sanitizeStringList(body.topics, current.topics, 10)
  };
}

function sanitizeStringList(value, fallback = [], limit = 10) {
  const source = Array.isArray(value) ? value : fallback || [];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const text = String(item || "").replace(/\s+/g, " ").trim().slice(0, 260);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden" });

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store"
    });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      const body = await readFile(path.join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(body);
      return;
    }
    throw error;
  }
}

async function readJson(req, maxBytes = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "text/html; charset=utf-8";
}

function sanitizeHeaderFilename(filename) {
  return String(filename || "file").replace(/["\r\n\\]/g, "_");
}

function createTitle(content) {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 46 ? `${compact.slice(0, 43)}...` : compact || "New chat";
}
