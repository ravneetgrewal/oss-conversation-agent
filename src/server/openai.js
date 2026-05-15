import { fileToBase64, fileToDataUrl, isFileInput, isImageInput } from "./attachments.js";

const OPENAI_API_URL = "https://api.openai.com/v1/responses";

export const models = [
  {
    key: "openai:gpt-5.4",
    id: "gpt-5.4",
    provider: "openai",
    label: "GPT-5.4",
    description: "High capability default",
    supportsFiles: true,
    supportsReasoning: true
  },
  {
    key: "openai:gpt-5.4-mini",
    id: "gpt-5.4-mini",
    provider: "openai",
    label: "GPT-5.4 mini",
    description: "Faster and lower cost",
    supportsFiles: true,
    supportsReasoning: true
  },
  {
    key: "openai:gpt-5.2",
    id: "gpt-5.2",
    provider: "openai",
    label: "GPT-5.2",
    description: "Stable fallback",
    supportsFiles: true,
    supportsReasoning: true
  },
  {
    key: "openai:gpt-4.1",
    id: "gpt-4.1",
    provider: "openai",
    label: "GPT-4.1",
    description: "Non-reasoning general model",
    supportsFiles: true,
    supportsReasoning: false
  }
];

export function getDefaultModel() {
  const configured = process.env.DEFAULT_MODEL;
  return models.some((model) => model.key === configured || model.id === configured) ? configured : "openai:gpt-5.4";
}

export async function* streamOpenAiResponse({ model, messages, files = [], memory = null, signal }) {
  if (!process.env.OPENAI_API_KEY) {
    yield* streamDemoResponse({ model, files, memory, messages, signal });
    return;
  }

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions: buildInstructions(memory),
      input: await toOpenAiInput(messages, files),
      stream: true,
      store: true
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed with ${response.status}: ${body}`);
  }

  yield* parseOpenAiSse(response.body);
}

function buildInstructions(memory) {
  const baseInstruction = process.env.DEFAULT_SYSTEM_PROMPT || "You are a concise, useful conversational agent.";
  if (!memory?.enabled) return baseInstruction;
  return [
    baseInstruction,
    "The backend may include a per-chat memory block as the first user message. Treat that memory as durable context for this conversation, but prefer newer explicit user instructions when they conflict."
  ].join("\n\n");
}

async function toOpenAiInput(messages, files) {
  return Promise.all(messages.map(async (message, index) => {
    const content = [];
    if (index === messages.length - 1 && message.role === "user") {
      for (const file of files || []) {
        if (file.providerFileId) {
          content.push({ type: "input_file", file_id: file.providerFileId });
        } else if (isImageInput(file)) {
          const imageUrl = await fileToDataUrl(file);
          if (imageUrl) content.push({ type: "input_image", image_url: imageUrl });
        } else if (isFileInput(file)) {
          const fileData = await fileToDataUrl(file);
          if (fileData) {
            content.push({
              type: "input_file",
              filename: file.filename,
              file_data: fileData
            });
          }
        } else if (file.textPreview) {
          content.push({
            type: "input_text",
            text: `Attached file: ${file.filename}\n\n${file.textPreview}`
          });
        }
      }
    }
    content.push({ type: "input_text", text: message.content || "" });
    return {
      role: message.role === "assistant" ? "assistant" : "user",
      content
    };
  }));
}

async function* parseOpenAiSse(body) {
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
        if (parsed.type === "response.output_text.delta") {
          yield { type: "message.delta", delta: parsed.delta ?? "" };
        } else if (parsed.type === "response.completed") {
          yield {
            type: "message.completed",
            providerResponseId: parsed.response?.id ?? null,
            usage: parsed.response?.usage ?? null
          };
        } else if (parsed.type === "response.failed" || parsed.type === "error") {
          throw new Error(parsed.error?.message || "OpenAI stream failed");
        }
      }
    }
  }
}

async function* streamDemoResponse({ model, files, memory, messages, signal }) {
  const attachmentNote = files.length
    ? ` I can also see ${files.length} attached file${files.length === 1 ? "" : "s"} in this local build.`
    : "";
  const memoryNote = memory?.summary
    ? ` Per-chat memory is active; I remember that ${memory.summary.slice(0, 180)}`
    : "";
  const lastUser = [...messages].reverse().find((message) => message.role === "user" && !message.id?.startsWith("memory-"));
  const text = [
    `Demo mode is active because OPENAI_API_KEY is not set.`,
    ` The selected model is ${model}.`,
    attachmentNote,
    memoryNote,
    lastUser ? ` Your latest message was: "${lastUser.content.slice(0, 120)}".` : "",
    ` Streaming, persistence, model selection, stop, retry, per-chat memory, and the chat layout are running locally.`,
    ` Add an OpenAI key and restart the server to use the Responses API.`
  ].join("");

  for (const token of text.match(/.{1,12}/g) ?? []) {
    if (signal?.aborted) throw new Error("Request cancelled");
    await new Promise((resolve) => setTimeout(resolve, 45));
    yield { type: "message.delta", delta: token };
  }
  yield { type: "message.completed", providerResponseId: "demo-response", usage: null };
}
