const DEFAULT_MEMORY_THRESHOLD = Number(process.env.MEMORY_TOKEN_THRESHOLD || 1400);
const RECENT_MESSAGE_LIMIT = Number(process.env.MEMORY_RECENT_MESSAGES || 10);
const CHAIRMAN_PERSONA_ID = "chairman";

export function createEmptyMemory(conversationId) {
  const now = new Date().toISOString();
  return {
    conversationId,
    enabled: true,
    summary: "",
    facts: [],
    decisions: [],
    openQuestions: [],
    topics: [],
    personaSummaries: {},
    messageCount: 0,
    estimatedTokens: 0,
    summarizedMessages: 0,
    recentMessagesPreserved: RECENT_MESSAGE_LIMIT,
    updatedAt: now
  };
}

export function shouldUpdateMemory(messages, memory, { force = false } = {}) {
  if (memory?.enabled === false) return false;
  if (force) return true;
  const completedMessages = messages.filter(isCompletedContentMessage);
  if (completedMessages.length < 2) return false;
  if ((memory?.messageCount || 0) !== completedMessages.length) return true;
  return estimateConversationTokens(completedMessages) >= DEFAULT_MEMORY_THRESHOLD;
}

export function buildMemorySnapshot(conversationId, messages, currentMemory = null) {
  const completedMessages = messages.filter(isCompletedContentMessage);
  const userMessages = completedMessages.filter((message) => message.role === "user");
  const assistantMessages = completedMessages.filter((message) => message.role === "assistant");
  const sharedAssistantMessages = assistantMessages.filter(isSharedAssistantMessage);
  const now = new Date().toISOString();
  const facts = mergeUnique([
    ...(currentMemory?.facts || []),
    ...extractFacts(userMessages)
  ], 14);
  const decisions = mergeUnique([
    ...(currentMemory?.decisions || []),
    ...extractDecisions([...userMessages, ...sharedAssistantMessages])
  ], 10);
  const openQuestions = mergeUnique(extractOpenQuestions(userMessages), 8);
  const topics = mergeUnique(extractTopics(userMessages), 10);
  const summary = createSummary({ userMessages, topics, decisions, currentSummary: currentMemory?.summary || "" });
  const personaSummaries = buildPersonaSummaries(assistantMessages, currentMemory?.personaSummaries || {});

  return {
    ...createEmptyMemory(conversationId),
    enabled: currentMemory?.enabled !== false,
    summary,
    facts,
    decisions,
    openQuestions,
    topics,
    personaSummaries,
    messageCount: completedMessages.length,
    estimatedTokens: estimateConversationTokens(completedMessages),
    summarizedMessages: Math.max(0, completedMessages.length - RECENT_MESSAGE_LIMIT),
    recentMessagesPreserved: RECENT_MESSAGE_LIMIT,
    updatedAt: now
  };
}

export function prepareMessagesForModel(messages, memory, { personaId = null } = {}) {
  const completedMessages = messages
    .filter(isCompletedContentMessage)
    .filter((message) => shouldIncludeForPersona(message, personaId));
  if (!memory?.enabled || !hasMemoryContent(memory, personaId)) return completedMessages;

  const recentMessages = completedMessages.slice(-RECENT_MESSAGE_LIMIT);
  const olderMessagesWereSummarized = completedMessages.length > recentMessages.length;
  const memoryText = renderMemoryForPrompt(memory, olderMessagesWereSummarized, personaId);
  return [
    {
      id: `memory-${memory.conversationId}`,
      conversationId: memory.conversationId,
      role: "user",
      content: memoryText,
      status: "completed",
      files: [],
      personaId,
      createdAt: memory.updatedAt,
      updatedAt: memory.updatedAt
    },
    ...recentMessages
  ];
}

export function renderMemoryForPrompt(memory, olderMessagesWereSummarized = true, personaId = null) {
  const personaSummary = personaId ? memory.personaSummaries?.[personaId] : "";
  const sections = [
    "Per-chat memory for this conversation.",
    olderMessagesWereSummarized
      ? "Use this memory as durable context for older parts of the chat, then rely on recent messages for exact wording."
      : "Use this memory as durable context for this chat.",
    memory.summary ? `Summary: ${memory.summary}` : "",
    memory.facts?.length ? `User facts and preferences:\n${memory.facts.map((item) => `- ${item}`).join("\n")}` : "",
    memory.decisions?.length ? `Decisions and requirements:\n${memory.decisions.map((item) => `- ${item}`).join("\n")}` : "",
    memory.openQuestions?.length ? `Open questions:\n${memory.openQuestions.map((item) => `- ${item}`).join("\n")}` : "",
    memory.topics?.length ? `Topics:\n${memory.topics.map((item) => `- ${item}`).join("\n")}` : "",
    personaSummary ? `Memory for this persona only:\n${personaSummary}` : ""
  ].filter(Boolean);
  return sections.join("\n\n");
}

function createSummary({ userMessages, topics, decisions, currentSummary }) {
  const latestUserGoals = userMessages
    .map((message) => cleanSentence(message.content))
    .filter(Boolean)
    .slice(-5);

  const parts = [];
  if (topics.length) parts.push(`The chat has focused on ${topics.slice(0, 5).join(", ")}.`);
  if (latestUserGoals.length) parts.push(`Recent user goals: ${latestUserGoals.join(" ")}`);
  if (decisions.length) parts.push(`Notable decisions: ${decisions.slice(0, 4).join(" ")}`);
  if (!parts.length && currentSummary) return currentSummary;
  return parts.join(" ").slice(0, 1800);
}

function buildPersonaSummaries(assistantMessages, currentSummaries = {}) {
  const summaries = { ...currentSummaries };
  const grouped = new Map();
  for (const message of assistantMessages) {
    if (!message.personaId || message.personaId === CHAIRMAN_PERSONA_ID) continue;
    if (!grouped.has(message.personaId)) grouped.set(message.personaId, []);
    grouped.get(message.personaId).push(message);
  }

  for (const [personaId, messages] of grouped) {
    const latest = messages
      .map((message) => cleanSentence(message.content))
      .filter(Boolean)
      .slice(-3);
    if (latest.length) summaries[personaId] = latest.join(" ").slice(0, 900);
  }
  return summaries;
}

function extractFacts(userMessages) {
  const factPatterns = [
    /\bmy name is\b/i,
    /\bi am\b/i,
    /\bi'm\b/i,
    /\bi work\b/i,
    /\bi use\b/i,
    /\bi prefer\b/i,
    /\bremember\b/i,
    /\bfor this chat\b/i,
    /\bwe need\b/i,
    /\bi want\b/i,
    /\bthe app should\b/i,
    /\bthe assistant should\b/i
  ];
  return userMessages
    .flatMap((message) => splitSentences(message.content))
    .filter((sentence) => factPatterns.some((pattern) => pattern.test(sentence)))
    .map(cleanSentence);
}

function extractDecisions(messages) {
  const decisionPatterns = [
    /\bwe will\b/i,
    /\blet's\b/i,
    /\bstart with\b/i,
    /\buse\b/i,
    /\bmust\b/i,
    /\bneeds? to\b/i,
    /\bshould\b/i,
    /\bdo not\b/i,
    /\bdon't\b/i,
    /\bdecided\b/i
  ];
  return messages
    .flatMap((message) => splitSentences(message.content))
    .filter((sentence) => decisionPatterns.some((pattern) => pattern.test(sentence)))
    .map(cleanSentence);
}

function extractOpenQuestions(userMessages) {
  return userMessages
    .flatMap((message) => splitSentences(message.content))
    .filter((sentence) => sentence.trim().endsWith("?"))
    .map(cleanSentence);
}

function extractTopics(userMessages) {
  const stopWords = new Set([
    "about", "after", "again", "agent", "also", "assistant", "because", "before", "build",
    "chat", "clone", "could", "feature", "from", "have", "like", "memory", "model", "need",
    "okay", "please", "should", "start", "style", "that", "there", "this", "want", "with", "would"
  ]);
  const counts = new Map();
  for (const message of userMessages) {
    const words = message.content.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [];
    for (const word of words) {
      if (stopWords.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

function estimateConversationTokens(messages) {
  return messages.reduce((total, message) => total + Math.ceil((message.content || "").length / 4), 0);
}

function isCompletedContentMessage(message) {
  return ["user", "assistant"].includes(message.role) && message.status !== "failed" && message.status !== "cancelled" && Boolean(message.content?.trim());
}

function hasMemoryContent(memory, personaId = null) {
  return Boolean(
    memory.summary ||
    memory.facts?.length ||
    memory.decisions?.length ||
    memory.openQuestions?.length ||
    memory.topics?.length ||
    (personaId && memory.personaSummaries?.[personaId])
  );
}

function shouldIncludeForPersona(message, personaId) {
  if (message.role !== "assistant" || !personaId) return true;
  return !message.personaId || message.personaId === CHAIRMAN_PERSONA_ID || message.personaId === personaId;
}

function isSharedAssistantMessage(message) {
  return !message.personaId || message.personaId === CHAIRMAN_PERSONA_ID;
}

function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function cleanSentence(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/^[-*]\s*/, "")
    .trim()
    .slice(0, 260);
}

function mergeUnique(items, limit) {
  const seen = new Set();
  const result = [];
  for (const item of items.map(cleanSentence).filter(Boolean)) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}
