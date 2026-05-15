import { models as openAiModels, streamOpenAiResponse } from "./openai.js";
import { fileToDataUrl, isImageInput } from "./attachments.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const openRouterModels = [
  {
    key: "openrouter:openai/gpt-4.1",
    id: "openai/gpt-4.1",
    provider: "openrouter",
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
    label: "OpenRouter Llama 70B",
    description: "Llama model via OpenRouter",
    supportsFiles: false,
    supportsImages: true,
    supportsReasoning: false
  }
];

export const models = [...openAiModels, ...openRouterModels];

export function getDefaultModel() {
  const configured = process.env.DEFAULT_MODEL;
  return resolveModel(configured)?.key || "openai:gpt-5.4";
}

export function resolveModel(modelKey) {
  if (!modelKey) return models.find((model) => model.key === "openai:gpt-5.4");
  return models.find((model) => model.key === modelKey) ||
    models.find((model) => model.id === modelKey && model.provider === "openai") ||
    models.find((model) => model.id === modelKey) ||
    null;
}

export async function* streamAssistantResponse({ model, messages, files = [], memory = null, signal }) {
  const selected = resolveModel(model) || resolveModel(getDefaultModel());
  if (selected.provider === "openrouter") {
    yield* streamOpenRouterResponse({ model: selected.id, label: selected.label, messages, files, memory, signal });
    return;
  }
  yield* streamOpenAiResponse({ model: selected.id, messages, files, memory, signal });
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
