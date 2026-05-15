import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DATA_DIR = path.resolve("data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const initialState = {
  conversations: [],
  messages: [],
  files: [],
  memories: []
};

let state = null;
let writeQueue = Promise.resolve();

export async function loadStore() {
  if (state) return state;
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await readFile(DB_PATH, "utf8");
    state = JSON.parse(raw);
    state.conversations ??= [];
    state.messages ??= [];
    state.files ??= [];
    state.memories ??= [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = structuredClone(initialState);
    await persist();
  }
  return state;
}

export async function persist() {
  await mkdir(DATA_DIR, { recursive: true });
  writeQueue = writeQueue.then(async () => {
    const tempPath = `${DB_PATH}.tmp`;
    await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tempPath, DB_PATH);
  });
  return writeQueue;
}

export async function listConversations() {
  await loadStore();
  return [...state.conversations]
    .filter((conversation) => !conversation.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getConversation(id) {
  await loadStore();
  return state.conversations.find((conversation) => conversation.id === id && !conversation.archivedAt) ?? null;
}

export async function createConversation({ title = "New chat", model }) {
  await loadStore();
  const now = new Date().toISOString();
  const conversation = {
    id: randomUUID(),
    title,
    model,
    provider: "openai",
    createdAt: now,
    updatedAt: now,
    archivedAt: null
  };
  state.conversations.push(conversation);
  await persist();
  return conversation;
}

export async function updateConversation(id, patch) {
  await loadStore();
  const conversation = state.conversations.find((item) => item.id === id);
  if (!conversation) return null;
  Object.assign(conversation, patch, { updatedAt: new Date().toISOString() });
  await persist();
  return conversation;
}

export async function listMessages(conversationId) {
  await loadStore();
  return state.messages
    .filter((message) => message.conversationId === conversationId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addMessage({ conversationId, role, content = "", model = null, status = "completed", files = [] }) {
  await loadStore();
  const now = new Date().toISOString();
  const message = {
    id: randomUUID(),
    conversationId,
    role,
    content,
    model,
    status,
    files,
    providerResponseId: null,
    usage: null,
    error: null,
    createdAt: now,
    updatedAt: now
  };
  state.messages.push(message);
  await updateConversationTimestamp(conversationId);
  await persist();
  return message;
}

export async function updateMessage(id, patch) {
  await loadStore();
  const message = state.messages.find((item) => item.id === id);
  if (!message) return null;
  Object.assign(message, patch, { updatedAt: new Date().toISOString() });
  await updateConversationTimestamp(message.conversationId, false);
  await persist();
  return message;
}

export async function deleteMessagesAfter(conversationId, messageId) {
  await loadStore();
  const messages = state.messages
    .filter((message) => message.conversationId === conversationId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const index = messages.findIndex((message) => message.id === messageId);
  if (index === -1) return [];
  const removed = messages.slice(index + 1).map((message) => message.id);
  state.messages = state.messages.filter((message) => !removed.includes(message.id));
  await updateConversationTimestamp(conversationId, false);
  await persist();
  return removed;
}

export async function addFile(file) {
  await loadStore();
  const now = new Date().toISOString();
  const record = {
    id: randomUUID(),
    provider: "local",
    providerFileId: null,
    status: "ready",
    createdAt: now,
    ...file
  };
  state.files.push(record);
  await persist();
  return record;
}

export async function getFiles(ids) {
  await loadStore();
  const idSet = new Set(ids);
  return state.files.filter((file) => idSet.has(file.id));
}

export async function getFile(id) {
  await loadStore();
  return state.files.find((file) => file.id === id) ?? null;
}

export async function getMemory(conversationId) {
  await loadStore();
  return state.memories.find((memory) => memory.conversationId === conversationId) ?? null;
}

export async function upsertMemory(conversationId, memory) {
  await loadStore();
  const index = state.memories.findIndex((item) => item.conversationId === conversationId);
  const nextMemory = {
    ...memory,
    conversationId,
    updatedAt: new Date().toISOString()
  };
  if (index === -1) {
    state.memories.push(nextMemory);
  } else {
    state.memories[index] = nextMemory;
  }
  await updateConversationTimestamp(conversationId, false);
  await persist();
  return nextMemory;
}

async function updateConversationTimestamp(conversationId, persistAfter = false) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (conversation) conversation.updatedAt = new Date().toISOString();
  if (persistAfter) await persist();
}
