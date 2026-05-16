import { models as openAiModels, streamOpenAiResponse } from "./openai.js";
import { fileToDataUrl, isImageInput } from "./attachments.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENAI_MODELS_API_URL = "https://api.openai.com/v1/models";
const OPENROUTER_MODELS_API_URL = "https://openrouter.ai/api/v1/models";
const MODEL_CATALOG_TTL_MS = 20 * 60 * 1000;
const OPENAI_DIRECT_MODEL_LIMIT = 4;
const OPENROUTER_MODELS_PER_UPSTREAM = 3;
const OPENROUTER_UPSTREAM_ORDER = ["openai", "anthropic", "google", "meta-llama", "deepseek", "x-ai", "mistralai", "qwen"];

const openRouterModels = [
  {
    key: "openrouter:openai/gpt-4.1",
    id: "openai/gpt-4.1",
    provider: "openrouter",
    upstreamProvider: "openai",
    upstreamProviderLabel: "OpenAI",
    label: "OpenRouter GPT-4.1",
    description: "OpenAI model via OpenRouter",
    supportsFiles: true,
    supportsImages: true,
    supportsReasoning: false
  },
  {
    key: "openrouter:anthropic/claude-sonnet-4.5",
    id: "anthropic/claude-sonnet-4.5",
    provider: "openrouter",
    upstreamProvider: "anthropic",
    upstreamProviderLabel: "Anthropic",
    label: "OpenRouter Claude Sonnet",
    description: "Anthropic model via OpenRouter",
    supportsFiles: false,
    supportsImages: true,
    supportsReasoning: true
  },
  {
    key: "openrouter:google/gemini-2.5-pro",
    id: "google/gemini-2.5-pro",
    provider: "openrouter",
    upstreamProvider: "google",
    upstreamProviderLabel: "Google",
    label: "OpenRouter Gemini Pro",
    description: "Google model via OpenRouter",
    supportsFiles: false,
    supportsImages: true,
    supportsReasoning: true
  },
  {
    key: "openrouter:meta-llama/llama-3.3-70b-instruct",
    id: "meta-llama/llama-3.3-70b-instruct",
    provider: "openrouter",
    upstreamProvider: "meta-llama",
    upstreamProviderLabel: "Meta Llama",
    label: "OpenRouter Llama 70B",
    description: "Llama model via OpenRouter",
    supportsFiles: false,
    supportsImages: true,
    supportsReasoning: false
  }
];

const fallbackModels = [...openAiModels, ...openRouterModels].map((model) => ({
  ...model,
  source: "fallback",
  recommended: true
}));

export const models = [...fallbackModels];

let modelCatalog = {
  fetchedAt: null,
  errors: [],
  source: "fallback"
};

export function getDefaultModel() {
  const configured = process.env.DEFAULT_MODEL;
  return resolveModel(configured)?.key || "openai:gpt-5.4";
}

export function resolveModel(modelKey) {
  if (!modelKey) return models.find((model) => model.key === "openai:gpt-5.4");
  return models.find((model) => model.key === modelKey) ||
    models.find((model) => model.id === modelKey && model.provider === "openai") ||
    models.find((model) => model.id === modelKey) ||
    fallbackModels.find((model) => model.key === modelKey) ||
    fallbackModels.find((model) => model.id === modelKey && model.provider === "openai") ||
    fallbackModels.find((model) => model.id === modelKey) ||
    null;
}

export async function getModelCatalog({ force = false } = {}) {
  if (!force && modelCatalog.fetchedAt && Date.now() - Date.parse(modelCatalog.fetchedAt) < MODEL_CATALOG_TTL_MS) {
    return { models, ...modelCatalog };
  }
  return refreshModelCatalog();
}

export async function refreshModelCatalog() {
  const errors = [];
  const discovered = [];

  try {
    discovered.push(...await fetchOpenAiModels());
  } catch (error) {
    errors.push(`OpenAI: ${error.message}`);
  }

  try {
    discovered.push(...await fetchOpenRouterModels());
  } catch (error) {
    errors.push(`OpenRouter: ${error.message}`);
  }

  const nextModels = buildDisplayCatalog(discovered);
  models.splice(0, models.length, ...nextModels);
  modelCatalog = {
    fetchedAt: new Date().toISOString(),
    errors,
    source: discovered.length ? "discovered" : "fallback"
  };
  return { models, ...modelCatalog };
}

export async function* streamAssistantResponse({ model, messages, files = [], memory = null, signal }) {
  const selected = resolveModel(model) || resolveModel(getDefaultModel());
  if (selected.provider === "openrouter") {
    yield* streamOpenRouterResponse({ model: selected.id, label: selected.label, messages, files, memory, signal });
    return;
  }
  yield* streamOpenAiResponse({ model: selected.id, messages, files, memory, signal });
}

async function fetchOpenAiModels() {
  if (!process.env.OPENAI_API_KEY) return [];
  const response = await fetch(OPENAI_MODELS_API_URL, {
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    }
  });
  if (!response.ok) throw new Error(`models endpoint returned HTTP ${response.status}`);
  const payload = await response.json();
  const records = Array.isArray(payload.data) ? payload.data : [];
  return records
    .map(normalizeOpenAiModel)
    .filter(Boolean)
    .filter((model) => model.recommended)
    .sort(compareModelFreshness)
    .slice(0, OPENAI_DIRECT_MODEL_LIMIT);
}

function normalizeOpenAiModel(record) {
  const id = String(record?.id || "");
  if (!id || !isRecommendedChatModel(id, "openai")) return null;
  return {
    key: `openai:${id}`,
    id,
    provider: "openai",
    upstreamProvider: "openai",
    upstreamProviderLabel: "OpenAI",
    label: formatModelLabel(id),
    description: "OpenAI discovered model",
    supportsFiles: true,
    supportsImages: true,
    supportsReasoning: /^o\d|reason|gpt-5|gpt-4\.1|gpt-4o/i.test(id),
    recommended: true,
    source: "discovered",
    created: record.created ?? null
  };
}

async function fetchOpenRouterModels() {
  if (!process.env.OPENROUTER_API_KEY) return [];
  const headers = {
    "HTTP-Referer": process.env.APP_PUBLIC_URL || "http://127.0.0.1",
    "X-Title": "OSS Conversation Agent",
    "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`
  };
  const response = await fetch(OPENROUTER_MODELS_API_URL, { headers });
  if (!response.ok) throw new Error(`models endpoint returned HTTP ${response.status}`);
  const payload = await response.json();
  const records = Array.isArray(payload.data) ? payload.data : [];
  return records
    .map(normalizeOpenRouterModel)
    .filter(Boolean)
    .filter((model) => model.recommended);
}

function normalizeOpenRouterModel(record) {
  const id = String(record?.id || "");
  if (!id || !isRecommendedChatModel(id, "openrouter", record)) return null;
  const inputModalities = record.architecture?.input_modalities || [];
  const supportedParameters = record.supported_parameters || [];
  const upstream = extractOpenRouterUpstream(id);
  return {
    key: `openrouter:${id}`,
    id,
    provider: "openrouter",
    upstreamProvider: upstream,
    upstreamProviderLabel: upstreamProviderLabel(upstream),
    label: formatModelLabel(id.split("/").pop() || id),
    description: record.description || "OpenRouter discovered model",
    supportsFiles: Boolean(inputModalities.includes("file")),
    supportsImages: inputModalities.includes("image"),
    supportsReasoning: supportedParameters.includes("reasoning") || /reason|thinking|sonnet|opus|gemini|o\d/i.test(id),
    contextLength: record.context_length ?? null,
    pricing: record.pricing ?? null,
    recommended: true,
    source: "discovered",
    created: record.created ?? null
  };
}

function buildDisplayCatalog(discovered) {
  const openAiLive = discovered.filter((model) => model.provider === "openai");
  const openRouterLive = discovered.filter((model) => model.provider === "openrouter");
  const openAiModelsForDisplay = (openAiLive.length ? openAiLive : fallbackModels.filter((model) => model.provider === "openai"))
    .sort(compareModelFreshness)
    .slice(0, OPENAI_DIRECT_MODEL_LIMIT);
  const openRouterModelsForDisplay = selectOpenRouterDisplayModels(
    openRouterLive.length ? openRouterLive : fallbackModels.filter((model) => model.provider === "openrouter")
  );
  return [...openAiModelsForDisplay, ...openRouterModelsForDisplay];
}

function selectOpenRouterDisplayModels(source) {
  const groups = source.reduce((result, model) => {
    const upstream = model.upstreamProvider || extractOpenRouterUpstream(model.id);
    result[upstream] ||= [];
    result[upstream].push({
      ...model,
      upstreamProvider: upstream,
      upstreamProviderLabel: model.upstreamProviderLabel || upstreamProviderLabel(upstream)
    });
    return result;
  }, {});
  return Object.entries(groups)
    .sort(([a], [b]) => upstreamRank(a) - upstreamRank(b) || a.localeCompare(b))
    .flatMap(([, upstreamModels]) => upstreamModels.sort(compareModelFreshness).slice(0, OPENROUTER_MODELS_PER_UPSTREAM));
}

function compareModelFreshness(a, b) {
  const provider = String(a.provider).localeCompare(String(b.provider));
  if (provider) return provider;
  const score = modelScore(b.id) - modelScore(a.id);
  if (score) return score;
  const created = Number(b.created || 0) - Number(a.created || 0);
  if (created) return created;
  return providerRank(a.id) - providerRank(b.id) || a.label.localeCompare(b.label);
}

function modelScore(id) {
  const lower = String(id || "").toLowerCase();
  let score = 0;
  if (lower.includes("latest")) score += 5000;
  if (lower.includes("preview")) score -= 120;
  if (lower.includes("beta")) score -= 160;
  if (lower.includes("mini")) score -= 30;
  if (lower.includes("nano")) score -= 90;
  if (lower.includes("turbo")) score -= 20;
  if (lower.includes("instruct")) score -= 8;
  if (lower.includes("gpt")) score += 1200;
  if (lower.includes("claude")) score += 1150;
  if (lower.includes("gemini")) score += 1100;
  if (lower.includes("llama")) score += 900;
  const numbers = lower.match(/\d+(?:\.\d+)?/g) || [];
  numbers.slice(0, 4).forEach((value, index) => {
    score += Number(value) * (100 / (index + 1));
  });
  return score;
}

function isRecommendedChatModel(id, provider, record = null) {
  const lower = id.toLowerCase();
  const blocked = [
    "embedding",
    "moderation",
    "whisper",
    "tts",
    "audio",
    "realtime",
    "transcribe",
    "image",
    "dall-e",
    "rerank",
    "search",
    "vision-preview"
  ];
  if (blocked.some((term) => lower.includes(term))) return false;
  if (provider === "openai") return /^(gpt-|o\d|o[1-9]|chatgpt-)/i.test(id);
  const inputModalities = record?.architecture?.input_modalities || [];
  if (inputModalities.length && !inputModalities.includes("text")) return false;
  const preferredProviders = [
    "openai/",
    "anthropic/",
    "google/",
    "meta-llama/",
    "deepseek/",
    "x-ai/",
    "mistralai/",
    "qwen/"
  ];
  return preferredProviders.some((prefix) => lower.startsWith(prefix));
}

function providerRank(id) {
  const lower = String(id || "").toLowerCase();
  const index = OPENROUTER_UPSTREAM_ORDER.findIndex((prefix) => lower.startsWith(`${prefix}/`));
  return index === -1 ? 99 : index;
}

function extractOpenRouterUpstream(id) {
  return String(id || "").split("/")[0] || "other";
}

function upstreamRank(upstream) {
  const index = OPENROUTER_UPSTREAM_ORDER.indexOf(upstream);
  return index === -1 ? 99 : index;
}

function upstreamProviderLabel(upstream) {
  const labels = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    "meta-llama": "Meta Llama",
    deepseek: "DeepSeek",
    "x-ai": "xAI",
    mistralai: "Mistral",
    qwen: "Qwen"
  };
  return labels[upstream] || formatModelLabel(upstream);
}

function formatModelLabel(id) {
  return String(id)
    .split("/")
    .pop()
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bGpt\b/g, "GPT")
    .replace(/\bO(\d)\b/g, "o$1")
    .replace(/\bAi\b/g, "AI");
}

async function* streamOpenRouterResponse({ model, label, messages, files = [], memory = null, signal }) {
  if (!process.env.OPENROUTER_API_KEY) {
    yield* streamProviderDemoResponse({ provider: "OpenRouter", model, files, memory, messages, signal });
    return;
  }

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_PUBLIC_URL || "http://127.0.0.1",
      "X-Title": "OSS Conversation Agent"
    },
    body: JSON.stringify({
      model,
      messages: await toChatMessages(messages, files, memory),
      stream: true
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(formatOpenRouterError({ status: response.status, body, modelLabel: label }));
  }

  yield* parseChatCompletionSse(response.body, label);
}

async function toChatMessages(messages, files, memory) {
  const system = [
    process.env.DEFAULT_SYSTEM_PROMPT || "You are a concise, useful conversational agent.",
    memory?.enabled
      ? "The backend may include a per-chat memory block as the first user message. Treat that memory as durable context for this conversation, but prefer newer explicit user instructions when they conflict."
      : ""
  ].filter(Boolean).join("\n\n");

  return [
    { role: "system", content: system },
    ...(await Promise.all(messages.map(async (message, index) => {
      let text = message.content || "";
      const contentParts = [];
      if (index === messages.length - 1 && message.role === "user" && files.length) {
        const fileText = files
          .filter((file) => file.textPreview)
          .map((file) => `Attached file: ${file.filename}\n\n${file.textPreview}`)
          .join("\n\n");
        if (fileText) text = `${fileText}\n\n${text}`;
        for (const file of files) {
          if (!isImageInput(file)) continue;
          const imageUrl = await fileToDataUrl(file);
          if (imageUrl) {
            contentParts.push({
              type: "image_url",
              image_url: { url: imageUrl }
            });
          }
        }
      }
      if (contentParts.length) contentParts.unshift({ type: "text", text });
      return {
        role: message.role === "assistant" ? "assistant" : "user",
        content: contentParts.length ? contentParts : text
      };
    })))
  ];
}

async function* parseChatCompletionSse(body, modelLabel) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const dataLines = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      for (const data of dataLines) {
        if (!data || data === "[DONE]") continue;
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield { type: "message.delta", delta };
        if (parsed.choices?.[0]?.finish_reason) {
          yield {
            type: "message.completed",
            providerResponseId: parsed.id ?? null,
            usage: parsed.usage ?? null
          };
        }
        if (parsed.error) throw new Error(formatOpenRouterError({ error: parsed.error, modelLabel }));
      }
    }
  }
}

function formatOpenRouterError({ status, body, error, modelLabel }) {
  const providerMessage = extractProviderErrorMessage(body, error);
  const lower = providerMessage.toLowerCase();
  const prefix = modelLabel ? `${modelLabel} could not complete this request.` : "OpenRouter could not complete this request.";

  if (lower.includes("image") || lower.includes("vision") || lower.includes("multimodal") || lower.includes("content part") || lower.includes("unsupported")) {
    return `${prefix} The provider response suggests this model may not support the attached image or file format. Try a multimodal model such as OpenRouter GPT-4.1, Claude Sonnet, Gemini Pro, or an OpenAI model. Provider error: ${providerMessage}`;
  }

  if (lower.includes("context") || lower.includes("token")) {
    return `${prefix} The request may be too large for this model. Try a smaller file, fewer attachments, or a model with a larger context window. Provider error: ${providerMessage}`;
  }

  if (lower.includes("rate") || lower.includes("quota") || lower.includes("credits")) {
    return `${prefix} OpenRouter reported a quota or rate-limit problem. Provider error: ${providerMessage}`;
  }

  if (status >= 500 || lower.includes("internal server error") || lower.includes("server error")) {
    return `${prefix} The upstream model provider failed after accepting the request. This is usually transient or model-specific; retry this pane or choose another model. Provider error: ${providerMessage}`;
  }

  if (status) {
    return `${prefix} OpenRouter returned HTTP ${status}. Provider error: ${providerMessage}`;
  }

  return `${prefix} Provider error: ${providerMessage}`;
}

function extractProviderErrorMessage(body, error) {
  if (error?.message) return String(error.message);
  if (!body) return "Unknown provider error.";
  try {
    const parsed = JSON.parse(body);
    return parsed.error?.message || parsed.message || body;
  } catch {
    return String(body).slice(0, 900);
  }
}

async function* streamProviderDemoResponse({ provider, model, files, memory, messages, signal }) {
  const attachmentNote = files.length ? ` I can see ${files.length} local attachment${files.length === 1 ? "" : "s"}.` : "";
  const memoryNote = memory?.summary ? ` Per-chat memory is active: ${memory.summary.slice(0, 160)}` : "";
  const lastUser = [...messages].reverse().find((message) => message.role === "user" && !message.id?.startsWith("memory-"));
  const text = [
    `${provider} demo mode is active because OPENROUTER_API_KEY is not set.`,
    ` The selected model is ${model}.`,
    attachmentNote,
    memoryNote,
    lastUser ? ` Your latest message was: "${lastUser.content.slice(0, 120)}".` : "",
    ` Add an OpenRouter key and restart the server to call OpenRouter.`
  ].join("");

  for (const token of text.match(/.{1,12}/g) ?? []) {
    if (signal?.aborted) throw new Error("Request cancelled");
    await new Promise((resolve) => setTimeout(resolve, 45));
    yield { type: "message.delta", delta: token };
  }
  yield { type: "message.completed", providerResponseId: "openrouter-demo-response", usage: null };
}
