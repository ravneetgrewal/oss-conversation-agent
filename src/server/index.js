import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "./env.js";
import { addMessage, createConversation, deleteMessagesAfter, getConversation, getFile, getFiles, getMemory, listConversations, listMessages, updateConversation, updateMessage, upsertMemory } from "./store.js";
import { getDefaultModel, getModelCatalog, refreshModelCatalog, resolveModel, streamAssistantResponse } from "./providers.js";
import { saveUploadedFile } from "./uploads.js";
import { buildMemorySnapshot, createEmptyMemory, prepareMessagesForModel, shouldUpdateMemory } from "./memory.js";
import { BRIEFING_PERSONA_ID, briefingPersona, CHAIRMAN_PERSONA_ID, chairmanPersona, listCouncilPacks, listPersonas, reportSynthesisPersona, resolvePersona } from "./personas.js";

await loadEnvFile();

const PORT = Number(process.env.APP_PORT || 4499);
const HOST = process.env.APP_HOST || "127.0.0.1";
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

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  console.log(`Conversation Agent running at http://${displayHost}:${PORT}`);
});

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    const catalog = await getModelCatalog();
    sendJson(res, 200, {
      defaultModel: getDefaultModel(),
      models: catalog.models,
      modelCatalog: {
        fetchedAt: catalog.fetchedAt,
        source: catalog.source,
        errors: catalog.errors
      },
      hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
      hasOpenRouterKey: Boolean(process.env.OPENROUTER_API_KEY),
      hasOllamaLocal: catalog.models.some((model) => model.provider === "ollama"),
      personas: listPersonas(),
      councilPacks: listCouncilPacks(),
      conversations: await listConversations()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/models/refresh") {
    const catalog = await refreshModelCatalog();
    sendJson(res, 200, {
      defaultModel: getDefaultModel(),
      models: catalog.models,
      modelCatalog: {
        fetchedAt: catalog.fetchedAt,
        source: catalog.source,
        errors: catalog.errors
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/council/report") {
    const body = await readJson(req);
    const entries = Array.isArray(body.entries) ? body.entries.filter((entry) => entry && entry.content) : [];
    if (!entries.length) return sendJson(res, 400, { error: "No council entries provided" });

    const transcript = entries
      .map((entry) => `### ${entry.personaName || "Seat"}\n${entry.content}`)
      .join("\n\n");
    const messages = [{
      role: "user",
      content: [
        `Topic: ${body.topic || "(not provided)"}`,
        `Council pack: ${body.packName || "(not provided)"}`,
        "",
        "Full council transcript:",
        transcript
      ].join("\n")
    }];

    const model = body.model || getDefaultModel();
    let accumulated = "";
    try {
      for await (const event of streamAssistantResponse({ model, messages, files: [], memory: null, persona: reportSynthesisPersona, signal: undefined })) {
        if (event.type === "message.delta") accumulated += event.delta;
      }
      const cleaned = accumulated.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      const report = JSON.parse(cleaned);
      sendJson(res, 200, { report, model });
    } catch (error) {
      sendJson(res, 502, { error: `Could not generate report: ${error.message}` });
    }
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
  const seats = resolveRequestedSeats(body, conversation);
  const model = seats[0].model;
  const orchestratorModel = resolveOrchestratorModel(body, conversation, seats);
  const fileIds = Array.isArray(body.fileIds) ? body.fileIds : [];
  if (!content && fileIds.length === 0) return sendJson(res, 400, { error: "Message content or file is required" });

  const files = await getFiles(fileIds);
  const previousMessages = await listMessages(conversationId);
  const pendingBriefing = findPendingBriefing(previousMessages);
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
  if (!pendingBriefing && shouldAskBriefing({ content, fileIds, seats, history: previousMessages })) {
    await streamBriefingPartner({ req, res, conversationId, model: orchestratorModel, userMessage, content, files });
    return;
  }
  const councilHistory = pendingBriefing ? buildBriefedCouncilHistory(history, pendingBriefing, userMessage) : history;
  await streamAssistantsForHistory({ req, res, conversationId, seats, orchestratorModel, files, history: councilHistory, userMessage, updateMemoryAfter: true });
}

async function streamBriefingPartner({ req, res, conversationId, model, userMessage, content, files }) {
  const briefingMessage = await addMessage({
    conversationId,
    role: "assistant",
    content: "",
    model,
    status: "streaming",
    turnId: userMessage.turnId,
    candidateIndex: 0,
    personaId: BRIEFING_PERSONA_ID,
    personaName: briefingPersona.name
  });
  let accumulated = "";
  let providerResponseId = null;
  let usage = null;
  let aborted = false;
  const abortController = new AbortController();
  req.on("close", () => {
    aborted = true;
    abortController.abort();
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  writeEvent(res, "message.started", { userMessage, assistantMessages: [briefingMessage] });
  try {
    const messages = [{ role: "user", content: buildBriefingPrompt(content, files) }];
    for await (const event of streamAssistantResponse({ model, messages, files: [], memory: null, persona: briefingPersona, signal: abortController.signal })) {
      if (aborted) break;
      if (event.type === "message.delta") {
        accumulated += event.delta;
        writeEvent(res, event.type, { messageId: briefingMessage.id, delta: event.delta });
      } else if (event.type === "message.completed") {
        providerResponseId = event.providerResponseId;
        usage = event.usage;
      }
    }
  } catch (error) {
    const fallback = buildBriefingQuestions(content, files);
    for (const chunk of chunkText(fallback, 18)) {
      if (aborted) break;
      accumulated += chunk;
      writeEvent(res, "message.delta", { messageId: briefingMessage.id, delta: chunk });
    }
  }

  const status = aborted ? "cancelled" : "completed";
  await updateMessage(briefingMessage.id, {
    content: accumulated,
    status,
    providerResponseId,
    usage
  });
  writeEvent(res, status === "completed" ? "message.completed" : "message.failed", {
    messageId: briefingMessage.id,
    status,
    providerResponseId: providerResponseId || "briefing-partner-fallback",
    usage,
    error: status === "cancelled" ? "Request cancelled" : undefined
  });
  res.end();
}

function buildBriefingPrompt(content, files) {
  const attachmentNote = files.length ? "The user attached files. Ask only for critical missing facts that are unlikely to be in the files." : "";
  return [
    "Prepare a brief clarification prompt before an expert council runs.",
    "Ask 3 to 5 numbered questions maximum.",
    "Format cleanly in markdown with one short intro sentence, one numbered list, and one closing sentence.",
    "The user can answer any subset by number, so make each question independently answerable.",
    "If the prompt is already sufficient, ask only the one or two questions that would most improve decision quality.",
    attachmentNote,
    "",
    "User prompt:",
    content || "(No text prompt provided.)"
  ].filter(Boolean).join("\n");
}

function shouldAskBriefing({ content, fileIds, seats, history }) {
  if (!shouldCreateChairman(seats)) return false;
  if (fileIds.length) return false;
  if (/\b(run it|run with assumptions|use assumptions|go ahead|send to council)\b/i.test(content)) return false;

  const words = content.toLowerCase().match(/[a-z0-9$%.-]+/g) || [];
  if (words.length <= 8) return true;

  const contextSignals = [
    /\b(my|i|we|our)\b/i,
    /\bgoal|criteria|constraint|budget|income|cash|timeline|horizon|risk|location|city|market|customer|user|price|cost|deadline\b/i,
    /\b\d+\s*(year|month|week|day|k|m|%|dollar|usd|rs|inr)s?\b/i,
    /[$%]/,
    /\bbecause|leaning|prefer|must|cannot|can't|need|want\b/i
  ];
  const signalCount = contextSignals.reduce((count, pattern) => count + (pattern.test(content) ? 1 : 0), 0);
  if (words.length <= 22 && signalCount < 2) return true;
  if (/\b(vs|versus|better|should i|worth it|good idea)\b/i.test(content) && signalCount < 2) return true;
  return false;
}

function buildBriefingQuestions(content, files) {
  const attachmentNote = files.length ? "I see an attachment, so answer only what is not already in the file." : "";
  return [
    "**I need a sharper brief before sending this to the council.**",
    attachmentNote,
    "",
    "1. What decision are you actually trying to make?",
    "2. What option are you leaning toward, if any?",
    "3. What does \"better\" mean here: money, speed, risk, freedom, stability, growth, or something else?",
    "4. What time horizon should the council optimize for?",
    "5. What constraints or facts would make the wrong answer costly?",
    "",
    "Reply with any numbers you want. Short answers are fine. If you want the council to run without more context, say \"run with assumptions.\""
  ].filter(Boolean).join("\n");
}

function chunkText(text, size = 18) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

function findPendingBriefing(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || last.personaId !== BRIEFING_PERSONA_ID) return null;
  const originalUser = [...messages].reverse().find((message) => message.role === "user" && message.createdAt < last.createdAt);
  if (!originalUser) return null;
  return {
    briefingMessage: last,
    originalUser
  };
}

function buildBriefedCouncilHistory(history, pendingBriefing, currentUserMessage) {
  const councilBrief = renderCouncilBrief({
    originalPrompt: pendingBriefing.originalUser.content,
    briefingQuestions: pendingBriefing.briefingMessage.content,
    userAnswers: currentUserMessage.content
  });
  return [
    ...history,
    {
      id: `briefed-council-${currentUserMessage.id}`,
      conversationId: currentUserMessage.conversationId,
      role: "user",
      content: councilBrief,
      model: currentUserMessage.model,
      status: "completed",
      files: [],
      turnId: currentUserMessage.turnId,
      candidateIndex: null,
      personaId: null,
      personaName: null,
      createdAt: currentUserMessage.createdAt,
      updatedAt: currentUserMessage.updatedAt
    }
  ];
}

function renderCouncilBrief({ originalPrompt, briefingQuestions, userAnswers }) {
  return [
    "Council Brief from Briefing Partner.",
    "Use the raw user wording and the normalized frame. Do not discard nuance from the raw text.",
    "",
    "Original user prompt:",
    originalPrompt || "",
    "",
    "Briefing Partner questions:",
    briefingQuestions || "",
    "",
    "User follow-up answers, raw:",
    userAnswers || "",
    "",
    "Normalized decision frame:",
    `Decision to make: ${inferDecisionFrame(originalPrompt, userAnswers)}`,
    `User leaning: ${inferLeaning(originalPrompt, userAnswers)}`,
    `Success criteria: ${inferSuccessCriteria(originalPrompt, userAnswers)}`,
    `Constraints/time horizon: ${inferConstraints(originalPrompt, userAnswers)}`,
    "Known unknowns: Any missing numbers, timeline, budget, risk tolerance, location, market facts, or personal constraints not provided above.",
    "Default assumption: If a detail is missing, make a reasonable default assumption, state it, and still make a call."
  ].join("\n");
}

function inferDecisionFrame(originalPrompt, userAnswers) {
  const text = `${originalPrompt || ""} ${userAnswers || ""}`.replace(/\s+/g, " ").trim();
  if (!text) return "Not explicitly stated.";
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function inferLeaning(originalPrompt, userAnswers) {
  const text = `${originalPrompt || ""}\n${userAnswers || ""}`;
  const leaning = text.match(/\b(?:leaning|prefer|option|choose|decision|thesis)\s*(?:is|toward|to|:)?\s*([^\n.]+)/i);
  if (leaning?.[1]) return leaning[1].trim().slice(0, 160);
  return "Not explicit. Infer from the user's wording, but mark it as an assumption.";
}

function inferSuccessCriteria(originalPrompt, userAnswers) {
  const text = `${originalPrompt || ""}\n${userAnswers || ""}`;
  const criteria = text.match(/\b(?:better means|goal|criteria|optimize|maximize|care about|success)\s*(?:is|are|for|:)?\s*([^\n.]+)/i);
  if (criteria?.[1]) return criteria[1].trim().slice(0, 180);
  return "Not explicit. Ask whether money, speed, risk, freedom, stability, growth, or quality is being optimized only if it would change the decision.";
}

function inferConstraints(originalPrompt, userAnswers) {
  const text = `${originalPrompt || ""}\n${userAnswers || ""}`;
  const constraints = text.match(/\b(?:constraint|timeline|horizon|budget|deadline|must|cannot|can't|risk)\s*(?:is|are|:)?\s*([^\n.]+)/i);
  if (constraints?.[1]) return constraints[1].trim().slice(0, 180);
  return "Not explicit. Use reasonable defaults and state them.";
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
  const seats = resolveRequestedSeats(body, conversation, trailingAssistants);
  const model = seats[0].model;
  const orchestratorModel = resolveOrchestratorModel(body, conversation, seats, trailingAssistants);
  const shouldRegenerateBriefing = trailingAssistants.some((message) => message.personaId === BRIEFING_PERSONA_ID) &&
    shouldAskBriefing({ content: lastUser.content || "", fileIds: lastUser.files || [], seats, history: messages.slice(0, lastUserIndex) });
  const pendingBriefing = findPendingBriefing(messages.slice(0, lastUserIndex));

  await deleteMessagesAfter(conversationId, lastUser.id);
  await updateConversation(conversationId, { model });
  const files = await getFiles(lastUser.files || []);
  if (shouldRegenerateBriefing) {
    await streamBriefingPartner({ req, res, conversationId, model: orchestratorModel, userMessage: lastUser, content: lastUser.content || "", files });
    return;
  }
  const history = await listMessages(conversationId);
  const regenerateHistory = pendingBriefing ? buildBriefedCouncilHistory(history, pendingBriefing, lastUser) : history;
  await streamAssistantsForHistory({ req, res, conversationId, seats, orchestratorModel, files, history: regenerateHistory, userMessage: null, updateMemoryAfter: false });
}

async function streamAssistantsForHistory({ req, res, conversationId, seats, orchestratorModel, files, history, userMessage, updateMemoryAfter = true }) {
  const memory = await getConversationMemory(conversationId);
  const lastHistoryUserIndex = findLastIndex(history, (message) => message.role === "user");
  const turnId = userMessage?.turnId || history[lastHistoryUserIndex]?.turnId || randomUUID();
  const expertMessages = [];
  for (const [index, seat] of seats.entries()) {
    expertMessages.push(await addMessage({
      conversationId,
      role: "assistant",
      content: "",
      model: seat.model,
      status: "streaming",
      turnId,
      candidateIndex: index,
      personaId: seat.personaId,
      personaName: seat.personaName
    }));
  }
  const chairmanMessage = shouldCreateChairman(seats)
    ? await addMessage({
        conversationId,
        role: "assistant",
        content: "",
        model: orchestratorModel || seats[0].model,
        status: "streaming",
        turnId,
        candidateIndex: -1,
        personaId: CHAIRMAN_PERSONA_ID,
        personaName: chairmanPersona.name
      })
    : null;
  const assistantMessages = chairmanMessage ? [chairmanMessage, ...expertMessages] : expertMessages;
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
    const persona = resolvePersona(assistantMessage.personaId);
    const modelMessages = prepareMessagesForModel(history, memory, { personaId: persona?.id || null });
    try {
      for await (const event of streamAssistantResponse({ model: assistantMessage.model, messages: modelMessages, files, memory, persona, signal: abortController.signal })) {
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
          assistantMessage.content = accumulated;
          assistantMessage.status = "completed";
          assistantMessage.providerResponseId = event.providerResponseId;
          assistantMessage.usage = event.usage;
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
      assistantMessage.content = accumulated;
      assistantMessage.status = status;
      assistantMessage.error = error.message;
      writeEvent(res, "message.failed", { messageId: assistantMessage.id, status, error: error.message });
    }
  };

  try {
    await Promise.all(expertMessages.map(streamOne));
    if (chairmanMessage && !abortController.signal.aborted) {
      await streamChairman({ chairmanMessage, expertMessages, history, memory, signal: abortController.signal, write: (event, data) => writeEvent(res, event, data) });
    }
    if (updateMemoryAfter) {
      const updatedMemory = await refreshConversationMemory(conversationId, memory);
      if (updatedMemory) writeEvent(res, "memory.updated", { memory: updatedMemory });
    }
  } finally {
    res.end();
  }
}

async function streamChairman({ chairmanMessage, expertMessages, history, memory, signal, write }) {
  let accumulated = "";
  try {
    const messages = buildChairmanMessages(history, expertMessages);
    for await (const event of streamAssistantResponse({ model: chairmanMessage.model, messages, files: [], memory, persona: chairmanPersona, signal })) {
      if (event.type === "message.delta") {
        accumulated += event.delta;
        write(event.type, { messageId: chairmanMessage.id, delta: event.delta });
      } else if (event.type === "message.completed") {
        await updateMessage(chairmanMessage.id, {
          content: accumulated,
          status: "completed",
          providerResponseId: event.providerResponseId,
          usage: event.usage
        });
        chairmanMessage.content = accumulated;
        chairmanMessage.status = "completed";
        write(event.type, { messageId: chairmanMessage.id, providerResponseId: event.providerResponseId, usage: event.usage });
      }
    }
  } catch (error) {
    const status = signal.aborted ? "cancelled" : "failed";
    await updateMessage(chairmanMessage.id, {
      content: accumulated,
      status,
      error: error.message
    });
    chairmanMessage.content = accumulated;
    chairmanMessage.status = status;
    chairmanMessage.error = error.message;
    write("message.failed", { messageId: chairmanMessage.id, status, error: error.message });
  }
}

function buildChairmanMessages(history, expertMessages) {
  const lastUser = [...history].reverse().find((message) => message.role === "user");
  const personaResponses = expertMessages.map((message) => {
    const name = message.personaName || resolvePersona(message.personaId)?.name || message.model || "Council seat";
    const status = message.status && message.status !== "completed" ? `Status: ${message.status}\n` : "";
    const error = message.error ? `Error: ${message.error}\n` : "";
    return `## ${name}\n${status}${error}${message.content?.trim() || "(No response captured.)"}`;
  }).join("\n\n");

  return [
    {
      role: "user",
      content: [
        "Synthesize the active council responses for the latest user topic into a decisive go-forward brief.",
        "You must use all active persona responses below. Your job is not to summarize passively; it is to make the best decision under uncertainty.",
        "If the user asked whether X is better than Y, choose X, choose Y, or reframe the comparison. Do not answer only with 'it depends'.",
        "If facts are missing, state default assumptions, give a confidence estimate, and say exactly what would change the decision.",
        "The final recommendation must be a concrete action, not a request for generic analysis.",
        "",
        "User topic:",
        lastUser?.content || "",
        "",
        "Active persona responses:",
        "",
        personaResponses
      ].join("\n")
    }
  ];
}

function shouldCreateChairman(seats) {
  return seats.length > 1 && seats.some((seat) => seat.personaId);
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
    if (selected.length === 4) break;
  }
  return selected.length ? selected : [getDefaultModel()];
}

function resolveRequestedSeats(body, conversation, fallbackMessages = []) {
  const requestedSeats = Array.isArray(body.seats) ? body.seats : [];
  const seats = [];

  if (requestedSeats.length) {
    for (const rawSeat of requestedSeats) {
      const model = resolveModel(rawSeat?.model || body.model || conversation.model || getDefaultModel())?.key;
      const persona = resolvePersona(rawSeat?.personaId);
      if (persona?.id === CHAIRMAN_PERSONA_ID) continue;
      if (!model) continue;
      addSeat(seats, { model, persona });
      if (seats.length >= 4) break;
    }
    if (seats.length) return seats;
  }

  for (const message of fallbackMessages) {
    if (message.personaId === CHAIRMAN_PERSONA_ID) continue;
    const model = resolveModel(message.model || conversation.model || getDefaultModel())?.key;
    const persona = resolvePersona(message.personaId);
    if (!model) continue;
    addSeat(seats, {
      model,
      persona,
      personaName: persona?.name || message.personaName || null
    });
    if (seats.length >= 4) break;
  }
  if (seats.length) return seats;

  return resolveRequestedModels(body, conversation).map((model) => ({
    model,
    personaId: null,
    personaName: null
  }));
}

function resolveOrchestratorModel(body, conversation, seats = [], fallbackMessages = []) {
  return resolveModel(body.orchestratorModel)?.key ||
    resolveModel(fallbackMessages.find((message) => message.personaId === CHAIRMAN_PERSONA_ID)?.model)?.key ||
    resolveModel(seats[0]?.model || conversation.model || body.model || getDefaultModel())?.key ||
    getDefaultModel();
}

function addSeat(seats, { model, persona, personaName = null }) {
  const personaId = persona?.id || null;
  if (personaId && seats.some((seat) => seat.personaId === personaId)) return;
  if (!personaId && seats.some((seat) => !seat.personaId && seat.model === model)) return;
  seats.push({
    model,
    personaId,
    personaName: persona?.name || personaName
  });
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
