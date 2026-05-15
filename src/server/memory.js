const DEFAULT_MEMORY_THRESHOLD = Number(process.env.MEMORY_TOKEN_THRESHOLD || 1400);
const RECENT_MESSAGE_LIMIT = Number(process.env.MEMORY_RECENT_MESSAGES || 10);

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
  const now = new Date().toISOString();
  const facts = mergeUnique([
    ...(currentMemory?.facts || []),
    ...extractFacts(userMessages)
  ], 14);
  const decisions = mergeUnique([
    ...(currentMemory?.decisions || []),
    ...extractDecisions(completedMessages)
  ], 10);
  const openQuestions = mergeUnique(extractOpenQuestions(userMessages), 8);
  const topics = mergeUnique(extractTopics(userMessages), 10);
  const summary = createSummary({ userMessages, assistantMessages, topics, decisions, currentSummary: currentMemory?.summary || "" });

  return {
    ...createEmptyMemory(conversationId),
    enabled: currentMemory?.enabled !== false,
    summary,
    facts,
    decisions,
    openQuestions,
    topics,
    messageCount: completedMessages.length,
    estimatedTokens: estimateConversationTokens(completedMessages),
    summarizedMessages: Math.max(0, completedMessages.length - RECENT_MESSAGE_LIMIT),
    recentMessagesPreserved: RECENT_MESSAGE_LIMIT,
    updatedAt: now
  };
}

export function prepareMessagesForModel(messages, memory) {
  const completedMessages = messages.filter(isCompletedContentMessage);
  if (!memory?.enabled || !hasMemoryContent(memory)) return completedMessages;

  const recentMessages = completedMessages.slice(-RECENT_MESSAGE_LIMIT);
  const olderMessagesWereSummarized = completedMessages.length > recentMessages.length;
  const memoryText = renderMemoryForPrompt(memory, olderMessagesWereSummarized);
  return [
    {
      id: `memory-${memory.conversationId}`,
      conversationId: memory.conversationId,
      role: "user",
      content: memoryText,
      status: "completed",
      files: [],
      createdAt: memory.updatedAt,
      updatedAt: memory.updatedAt
    },
    ...recentMessages
  ];
}

export function renderMemoryForPrompt(memory, olderMessagesWereSummarized = true) {
  const sections = [
    "Per-chat memory for this conversation.",
    olderMessagesWereSummarized
      ? "Use this memory as durable context for older parts of the chat, then rely on recent messages for exact wording."
      : "Use this memory as durable context for this chat.",
    memory.summary ? `Summary: ${memory.summary}` : "",
    memory.facts?.length ? `User facts and preferences:\n${memory.facts.map((item) => `- ${item}`).join("\n")}` : "",
    memory.decisions?.length ? `Decisions and requirements:\n${memory.decisions.map((item) => `- ${item}`).join("\n")}` : "",
    memory.openQuestions?.length ? `Open questions:\n${memory.openQuestions.map((item) => `- ${item}`).join("\n")}` : "",
    memory.topics?.length ? `Topics:\n${memory.topics.map((item) => `- ${item}`).join("\n")}` : ""
  ].filter(Boolean);
  return sections.join("\n\n");
}

function createSummary({ userMessages, assistantMessages, topics, decisions, currentSummary }) {
  const latestUserGoals = userMessages
    .map((message) => cleanSentence(message.content))
    .filter(Boolean)
    .slice(-5);
  const latestAssistantWork = assistantMessages
    .map((message) => cleanSentence(message.content))
    .filter(Boolean)
    .slice(-3);

  const parts = [];
  if (topics.length) parts.push(`The chat has focused on ${topics.slice(0, 5).join(", ")}.`);
  if (latestUserGoals.length) parts.push(`Recent user goals: ${latestUserGoals.join(" ")}`);
  if (decisions.length) parts.push(`Notable decisions: ${decisions.slice(0, 4).join(" ")}`);
  if (latestAssistantWork.length) parts.push(`Recent assistant work: ${latestAssistantWork.join(" ")}`);
  if (!parts.length && currentSummary) return currentSummary;
  return parts.join(" ").slice(0, 1800);
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

function hasMemoryContent(memory) {
  return Boolean(
    memory.summary ||
    memory.facts?.length ||
    memory.decisions?.length ||
    memory.openQuestions?.length ||
    memory.topics?.length
  );
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
