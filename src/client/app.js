const CHAIRMAN_PERSONA_ID = "chairman";
const CHAIRMAN_PERSONA_NAME = "Chairman Brief";
const BRIEFING_PERSONA_ID = "briefing_partner";
const BRIEFING_PERSONA_NAME = "Briefing Partner";

const state = {
  conversations: [],
  activeConversation: null,
  messages: [],
  filesById: new Map(),
  memory: null,
  models: [],
  modelCatalog: null,
  defaultModel: "",
  personas: [],
  councilPacks: [],
  councilPackId: "",
  pendingFiles: [],
  abortController: null,
  isStreaming: false,
  compareMode: false,
  compareModel: "",
  councilPanelOpen: false,
  councilViewMode: "columns",
  councilActivePersonaId: CHAIRMAN_PERSONA_ID,
  councilSeatCount: 3,
  orchestratorModel: "",
  councilSeats: [],
  activeStream: null
};

const els = {
  newChat: document.querySelector("#new-chat"),
  deleteChat: document.querySelector("#delete-chat"),
  conversationList: document.querySelector("#conversation-list"),
  search: document.querySelector("#conversation-search"),
  title: document.querySelector("#conversation-title"),
  connection: document.querySelector("#connection-state"),
  model: document.querySelector("#model-select"),
  modelPicker: document.querySelector("#model-picker"),
  modelPickerButton: document.querySelector("#model-picker-button"),
  modelPickerLabel: document.querySelector("#model-picker-label"),
  modelPickerMenu: document.querySelector("#model-picker-menu"),
  refreshModels: document.querySelector("#refresh-models"),
  compareToggle: document.querySelector("#compare-toggle"),
  councilViewToggle: document.querySelector("#council-view-toggle"),
  councilPanel: document.querySelector("#council-panel"),
  compareModel: document.querySelector("#compare-model-select"),
  compareModelPicker: document.querySelector("#compare-model-picker"),
  compareModelPickerButton: document.querySelector("#compare-model-picker-button"),
  compareModelPickerLabel: document.querySelector("#compare-model-picker-label"),
  compareModelPickerMenu: document.querySelector("#compare-model-picker-menu"),
  memoryToggle: document.querySelector("#memory-toggle"),
  memoryPanel: document.querySelector("#memory-panel"),
  memoryClose: document.querySelector("#memory-close"),
  memoryStats: document.querySelector("#memory-stats"),
  memoryEnabled: document.querySelector("#memory-enabled"),
  memorySummary: document.querySelector("#memory-summary"),
  memoryFacts: document.querySelector("#memory-facts"),
  memoryDecisions: document.querySelector("#memory-decisions"),
  memoryQuestions: document.querySelector("#memory-questions"),
  memorySave: document.querySelector("#memory-save"),
  regenerate: document.querySelector("#regenerate"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  input: document.querySelector("#message-input"),
  send: document.querySelector("#send-button"),
  stop: document.querySelector("#stop-button"),
  attach: document.querySelector("#attach-button"),
  fileInput: document.querySelector("#file-input"),
  attachmentList: document.querySelector("#attachment-list")
};

await bootstrap();
bindEvents();
closeModelPicker();
closeCompareModelPicker();

async function bootstrap() {
  const data = await api("/api/bootstrap");
  state.conversations = data.conversations;
  state.models = data.models;
  state.modelCatalog = data.modelCatalog || null;
  state.defaultModel = data.defaultModel;
  state.personas = data.personas || [];
  state.councilPacks = data.councilPacks || [];
  state.councilPackId = state.councilPacks[0]?.id || "";
  state.orchestratorModel = normalizeModelValue(data.defaultModel);
  state.councilSeats = createDefaultCouncilSeats();
  els.connection.textContent = [
    data.hasOpenAiKey ? "OpenAI" : "",
    data.hasOpenRouterKey ? "OpenRouter" : "",
    data.hasOllamaLocal ? "Ollama" : ""
  ].filter(Boolean).join(" + ") || "Demo mode";
  renderModels();
  renderConversations();

  if (state.conversations.length) {
    await loadConversation(state.conversations[0].id);
  } else {
    await createConversation();
  }
}

function bindEvents() {
  els.newChat.addEventListener("click", () => createConversation());
  els.search.addEventListener("input", renderConversations);
  els.refreshModels.addEventListener("click", refreshModels);
  els.model.addEventListener("change", updateModel);
  els.modelPickerButton.addEventListener("click", toggleModelPicker);
  els.compareToggle.addEventListener("click", toggleCompareMode);
  els.councilViewToggle.addEventListener("click", handleCouncilViewToggle);
  els.councilPanel.addEventListener("change", handleCouncilPanelChange);
  els.councilPanel.addEventListener("click", handleCouncilPanelClick);
  els.compareModel.addEventListener("change", updateCompareModel);
  els.compareModelPickerButton.addEventListener("click", toggleCompareModelPicker);
  document.addEventListener("click", closeModelPickerOnOutsideClick);
  document.addEventListener("keydown", closeModelPickerOnEscape);
  window.addEventListener("resize", positionCouncilPanel);
  els.memoryToggle.addEventListener("click", openMemoryPanel);
  els.memoryClose.addEventListener("click", closeMemoryPanel);
  els.memorySave.addEventListener("click", saveMemory);
  els.regenerate.addEventListener("click", regenerateLast);
  els.title.addEventListener("change", updateTitle);
  els.deleteChat.addEventListener("click", archiveConversation);
  els.composer.addEventListener("submit", sendMessage);
  els.messages.addEventListener("click", handleMessagesClick);
  els.stop.addEventListener("click", stopStreaming);
  els.attach.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", uploadFiles);
  els.input.addEventListener("input", autoresize);
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      els.composer.requestSubmit();
    }
  });
}

async function createConversation() {
  const { conversation } = await api("/api/conversations", {
    method: "POST",
    body: { model: state.defaultModel }
  });
  state.conversations.unshift(conversation);
  renderConversations();
  await loadConversation(conversation.id);
}

async function loadConversation(id) {
  const data = await api(`/api/conversations/${id}`);
  state.activeConversation = data.conversation;
  state.messages = data.messages;
  state.filesById = indexFiles(data.files || []);
  state.memory = data.memory;
  state.pendingFiles = [];
  els.title.value = data.conversation.title;
  els.title.disabled = false;
  setModelValue(normalizeModelValue(data.conversation.model || state.defaultModel));
  if (!state.compareModel || state.compareModel === els.model.value) {
    setCompareModelValue(getFallbackCompareModel(els.model.value));
  }
  if (!state.orchestratorModel) {
    state.orchestratorModel = normalizeModelValue(els.model.value);
  }
  syncCouncilSeatModelsToPrimary();
  syncCouncilSeatDefaults();
  renderCouncilPanel();
  renderConversations();
  renderMessages();
  renderMemoryPanel();
  renderAttachments();
  focusComposer();
}

async function updateModel() {
  if (!state.activeConversation) return;
  const previousModel = state.activeConversation.model;
  state.activeConversation.model = els.model.value;
  syncModelPicker();
  if (els.compareModel.value === els.model.value) setCompareModelValue(getFallbackCompareModel(els.model.value));
  if (!state.orchestratorModel || state.orchestratorModel === normalizeModelValue(previousModel)) {
    state.orchestratorModel = normalizeModelValue(els.model.value);
  }
  syncCouncilSeatModelsToPrimary();
  syncCouncilSeatDefaults();
  renderCouncilPanel();
  await api(`/api/conversations/${state.activeConversation.id}`, {
    method: "PATCH",
    body: { model: els.model.value }
  });
  renderConversations();
}

function updateCompareModel() {
  setCompareModelValue(els.compareModel.value);
}

async function refreshModels() {
  if (state.isStreaming) return;
  const currentModel = els.model.value;
  const currentCompareModel = els.compareModel.value;
  els.refreshModels.disabled = true;
  els.refreshModels.classList.add("spinning");
  els.connection.textContent = "Refreshing models";
  try {
    const data = await api("/api/models/refresh", { method: "POST" });
    state.models = data.models;
    state.modelCatalog = data.modelCatalog || null;
    state.defaultModel = data.defaultModel;
    state.orchestratorModel = normalizeModelValue(state.orchestratorModel || currentModel);
    renderModels({
      primary: normalizeModelValue(currentModel),
      compare: normalizeModelValue(currentCompareModel)
    });
    syncCouncilSeatDefaults();
    renderCouncilPanel();
    const errors = state.modelCatalog?.errors || [];
    els.connection.textContent = errors.length ? `Models refreshed with ${errors.length} warning${errors.length === 1 ? "" : "s"}` : "Models refreshed";
  } catch (error) {
    els.connection.textContent = "Model refresh failed";
  } finally {
    els.refreshModels.disabled = false;
    els.refreshModels.classList.remove("spinning");
  }
}

async function updateTitle() {
  if (!state.activeConversation) return;
  const title = els.title.value.trim() || "New chat";
  const { conversation } = await api(`/api/conversations/${state.activeConversation.id}`, {
    method: "PATCH",
    body: { title }
  });
  state.activeConversation = conversation;
  state.conversations = state.conversations.map((item) => item.id === conversation.id ? conversation : item);
  renderConversations();
}

async function archiveConversation() {
  if (!state.activeConversation || state.isStreaming) return;
  await api(`/api/conversations/${state.activeConversation.id}`, { method: "DELETE" });
  state.conversations = state.conversations.filter((item) => item.id !== state.activeConversation.id);
  renderConversations();
  if (state.conversations.length) {
    await loadConversation(state.conversations[0].id);
  } else {
    await createConversation();
  }
}

async function sendMessage(event) {
  event.preventDefault();
  if (state.isStreaming || !state.activeConversation) return;
  const content = els.input.value.trim();
  const fileIds = state.pendingFiles.map((file) => file.id);
  if (!content && fileIds.length === 0) return;
  const selectedSeats = getSelectedSeats();
  const orchestratorModel = getSelectedOrchestratorModel();
  const turnId = `local-turn-${Date.now()}`;

  const userMessage = {
    id: `local-user-${Date.now()}`,
    role: "user",
    content,
    files: fileIds,
    status: "completed",
    turnId,
    createdAt: new Date().toISOString()
  };
  const assistantMessages = createLocalCouncilMessages(selectedSeats, turnId, orchestratorModel);
  state.messages.push(userMessage, ...assistantMessages);
  els.input.value = "";
  state.pendingFiles = [];
  autoresize();
  renderAttachments();
  renderMessages();
  setStreaming(true);

  state.abortController = new AbortController();
  state.activeStream = {
    expectedAssistantCount: assistantMessages.length,
    compareUnsupported: false
  };
  try {
    await consumeSse(`/api/conversations/${state.activeConversation.id}/messages`, {
      content,
      model: els.model.value,
      orchestratorModel,
      seats: selectedSeats,
      fileIds
    }, state.abortController.signal);
    if (!state.activeStream?.compareUnsupported) {
      await refreshActiveConversation();
    } else {
      renderMessages(false);
    }
  } catch (error) {
    for (const assistantMessage of assistantMessages) {
      if (assistantMessage.status === "streaming") {
        assistantMessage.status = "failed";
        assistantMessage.content ||= error.message;
      }
    }
    renderMessages();
  } finally {
    state.activeStream = null;
    setStreaming(false);
  }
}

function createLocalCouncilMessages(selectedSeats, turnId, orchestratorModel = getSelectedOrchestratorModel()) {
  const messages = [];
  if (shouldUseChairman(selectedSeats)) {
    messages.push({
      id: `local-assistant-${Date.now()}-chairman`,
      role: "assistant",
      content: "",
      error: null,
      files: [],
      model: orchestratorModel,
      personaId: CHAIRMAN_PERSONA_ID,
      personaName: CHAIRMAN_PERSONA_NAME,
      status: "streaming",
      turnId,
      candidateIndex: -1,
      createdAt: new Date().toISOString()
    });
  }
  messages.push(...selectedSeats.map((seat, index) => ({
    id: `local-assistant-${Date.now()}-${index}`,
    role: "assistant",
    content: "",
    error: null,
    files: [],
    model: seat.model,
    personaId: seat.personaId,
    personaName: getPersonaName(seat.personaId),
    status: "streaming",
    turnId,
    candidateIndex: index,
    createdAt: new Date().toISOString()
  })));
  return messages;
}

function shouldUseChairman(selectedSeats) {
  return selectedSeats.length > 1 && selectedSeats.some((seat) => seat.personaId);
}

async function regenerateLast() {
  if (state.isStreaming || !state.activeConversation) return;
  const lastUserIndex = findLastIndex(state.messages, (message) => message.role === "user");
  if (lastUserIndex === -1) return;
  const previousCandidates = state.messages.slice(lastUserIndex + 1).filter((message) => message.role === "assistant");
  const previousExpertCandidates = previousCandidates.filter((message) => !isChairmanMessage(message));
  const selectedSeats = state.compareMode
    ? getSelectedSeats()
    : previousExpertCandidates.length > 1
      ? previousExpertCandidates.map(messageToSeat).slice(0, 3)
      : [{ model: els.model.value, personaId: previousExpertCandidates[0]?.personaId || null }];
  const previousChairman = previousCandidates.find(isChairmanMessage);
  const orchestratorModel = state.compareMode
    ? getSelectedOrchestratorModel()
    : normalizeModelValue(previousChairman?.model || els.model.value);
  const turnId = state.messages[lastUserIndex].turnId || `local-turn-${Date.now()}`;

  state.messages = state.messages.slice(0, lastUserIndex + 1);
  const assistantMessages = createLocalCouncilMessages(selectedSeats, turnId, orchestratorModel);
  state.messages.push(...assistantMessages);
  renderMessages();
  setStreaming(true);

  state.abortController = new AbortController();
  state.activeStream = {
    expectedAssistantCount: assistantMessages.length,
    compareUnsupported: false
  };
  try {
    await consumeSse(`/api/conversations/${state.activeConversation.id}/regenerate`, {
      model: els.model.value,
      orchestratorModel,
      seats: selectedSeats
    }, state.abortController.signal);
    if (!state.activeStream?.compareUnsupported) {
      await refreshActiveConversation();
    } else {
      renderMessages(false);
    }
  } catch (error) {
    for (const message of state.messages.slice(lastUserIndex + 1)) {
      if (message.role === "assistant" && message.status === "streaming") {
        message.status = "failed";
        message.content ||= error.message;
      }
    }
    renderMessages();
  } finally {
    state.activeStream = null;
    setStreaming(false);
  }
}

async function consumeSse(url, body, signal) {
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await response.text());

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const raw of events) handleSseEvent(raw);
  }
}

function handleSseEvent(raw) {
  const event = raw.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  const data = dataLine ? JSON.parse(dataLine.slice(5)) : {};

  if (event === "message.started") {
    const localUser = [...state.messages].reverse().find((message) => message.id?.startsWith("local-user"));
    if (data.userMessage && localUser) {
      localUser.id = data.userMessage.id;
      localUser.turnId = data.userMessage.turnId;
    }
    const serverAssistants = data.assistantMessages || (data.assistantMessage ? [data.assistantMessage] : []);
    const expectedAssistantCount = state.activeStream?.expectedAssistantCount || serverAssistants.length || 1;
    const localAssistants = state.messages.filter((message) => message.id?.startsWith("local-assistant")).slice(-expectedAssistantCount);
    const matchedLocalAssistants = new Set();
    const shouldReplaceLocalPlaceholders = serverAssistants.some((assistant) => assistant.personaId === BRIEFING_PERSONA_ID);
    serverAssistants.forEach((assistant, index) => {
      const localAssistant = findLocalAssistantMatch(localAssistants, assistant, matchedLocalAssistants) || localAssistants[index];
      if (!localAssistant) return;
      matchedLocalAssistants.add(localAssistant);
      localAssistant.id = assistant.id;
      localAssistant.turnId = assistant.turnId;
      localAssistant.candidateIndex = assistant.candidateIndex;
      localAssistant.model = assistant.model;
      localAssistant.personaId = assistant.personaId;
      localAssistant.personaName = assistant.personaName;
    });
    if (expectedAssistantCount > 1 && serverAssistants.length < expectedAssistantCount) {
      const unmatchedLocalAssistants = localAssistants.filter((message) => !matchedLocalAssistants.has(message));
      if (shouldReplaceLocalPlaceholders) {
        const unmatchedIds = new Set(unmatchedLocalAssistants.map((message) => message.id));
        state.messages = state.messages.filter((message) => !unmatchedIds.has(message.id));
      } else {
        state.activeStream.compareUnsupported = true;
        for (const assistant of unmatchedLocalAssistants) {
          assistant.status = "failed";
          assistant.error = "Council mode needs the updated backend. Restart the server, then send again.";
          assistant.content = assistant.error;
        }
        els.connection.textContent = "Restart server to enable Council";
      }
    }
  }

  if (event === "message.delta") {
    const message = state.messages.find((item) => item.id === data.messageId) || state.messages[state.messages.length - 1];
    message.content += data.delta;
    renderMessages(false);
  }

  if (event === "message.completed") {
    const message = state.messages.find((item) => item.id === data.messageId);
    if (message) {
      message.status = "completed";
      message.providerResponseId = data.providerResponseId;
      message.usage = data.usage;
    }
  }

  if (event === "message.failed") {
    const message = state.messages.find((item) => item.id === data.messageId);
    if (message) {
      message.status = data.status;
      message.error = data.error;
      if (!message.content) message.content = data.error;
    }
  }

  if (event === "memory.updated") {
    state.memory = data.memory;
    renderMemoryPanel();
  }
}

function findLocalAssistantMatch(localAssistants, assistant, matched) {
  return localAssistants.find((local) => !matched.has(local) && local.personaId === assistant.personaId && Number(local.candidateIndex) === Number(assistant.candidateIndex)) ||
    localAssistants.find((local) => !matched.has(local) && local.personaId === assistant.personaId) ||
    null;
}

function stopStreaming() {
  state.abortController?.abort();
}

async function refreshActiveConversation() {
  if (!state.activeConversation) return;
  const data = await api(`/api/conversations/${state.activeConversation.id}`);
  state.activeConversation = data.conversation;
  state.messages = data.messages;
  state.filesById = indexFiles(data.files || []);
  state.memory = data.memory;
  state.conversations = [
    data.conversation,
    ...state.conversations.filter((item) => item.id !== data.conversation.id)
  ];
  els.title.value = data.conversation.title;
  renderConversations();
  renderMessages();
  renderMemoryPanel();
}

function openMemoryPanel() {
  renderMemoryPanel();
  els.memoryPanel.hidden = false;
}

function closeMemoryPanel() {
  els.memoryPanel.hidden = true;
}

async function saveMemory() {
  if (!state.activeConversation) return;
  const { memory } = await api(`/api/conversations/${state.activeConversation.id}/memory`, {
    method: "PATCH",
    body: {
      enabled: els.memoryEnabled.checked,
      summary: els.memorySummary.value.trim(),
      facts: linesToList(els.memoryFacts.value),
      decisions: linesToList(els.memoryDecisions.value),
      openQuestions: linesToList(els.memoryQuestions.value),
      topics: state.memory?.topics || []
    }
  });
  state.memory = memory;
  renderMemoryPanel();
  els.connection.textContent = "Memory saved";
}

async function uploadFiles() {
  const files = [...els.fileInput.files];
  els.fileInput.value = "";
  for (const file of files) {
    els.connection.textContent = `Uploading ${file.name}`;
    const data = await fileToBase64(file);
    const result = await api("/api/uploads", {
      method: "POST",
      body: {
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        data
      }
    });
    state.filesById.set(result.file.id, result.file);
    state.pendingFiles.push(result.file);
  }
  els.connection.textContent = "Ready";
  renderAttachments();
}

function renderModels(selection = {}) {
  els.model.innerHTML = renderNativeModelOptions(selection.primary || state.defaultModel);
  els.compareModel.innerHTML = els.model.innerHTML;
  els.modelPickerMenu.innerHTML = renderModelOptions();
  els.compareModelPickerMenu.innerHTML = renderModelOptions();
  bindModelOptionClicks(els.modelPickerMenu, (value) => {
    setModelValue(value);
    closeModelPicker();
    updateModel();
  });
  bindModelOptionClicks(els.compareModelPickerMenu, (value) => {
    setCompareModelValue(value);
    closeCompareModelPicker();
  });
  setModelValue(selection.primary || state.defaultModel);
  setCompareModelValue(selection.compare || getFallbackCompareModel(els.model.value));
  syncCouncilSeatDefaults();
  renderCouncilPanel();
}

function renderNativeModelOptions(selectedValue = "") {
  return groupModelsForPicker().map((group) => {
    if (group.kind === "direct") {
      return `
        <optgroup label="${escapeHtml(group.label)}">
          ${group.models.map((model) => renderNativeModelOption(model, selectedValue)).join("")}
        </optgroup>
      `;
    }
    return group.upstreams.map((upstream) => `
      <optgroup label="OpenRouter / ${escapeHtml(upstream.label)}">
        ${upstream.models.map((model) => renderNativeModelOption(model, selectedValue)).join("")}
      </optgroup>
    `).join("");
  }).join("");
}

function renderNativeModelOption(model, selectedValue = "") {
  const selected = model.key === selectedValue ? " selected" : "";
  return `<option value="${escapeHtml(model.key)}"${selected}>${escapeHtml(model.label)}</option>`;
}

function renderModelOptions() {
  return groupModelsForPicker().map((group) => {
    if (group.kind === "direct") {
      return `
        <div class="model-option-group" role="presentation">
          <div class="model-option-heading">${escapeHtml(group.label)}</div>
          ${group.models.map(renderModelOption).join("")}
        </div>
      `;
    }
    return `
      <div class="model-option-group" role="presentation">
        <div class="model-option-heading">OpenRouter</div>
        ${group.upstreams.map((upstream) => `
          <div class="model-option-subgroup" role="presentation">
            <div class="model-option-subheading">${escapeHtml(upstream.label)}</div>
            ${upstream.models.map(renderModelOption).join("")}
          </div>
        `).join("")}
      </div>
    `;
  }).join("");
}

function renderModelOption(model) {
  return `
    <button class="model-option" type="button" role="option" data-value="${escapeHtml(model.key)}" title="${escapeHtml(model.description || model.id)}">
      <span>${escapeHtml(compactModelLabel(model))}</span>
      <small>${escapeHtml(model.source === "discovered" ? "live" : "fallback")}</small>
    </button>
  `;
}

function groupModelsForPicker() {
  const directGroups = new Map();
  const openRouterGroups = new Map();
  for (const model of state.models.filter((item) => item.recommended !== false)) {
    if (model.provider === "openrouter") {
      const upstream = model.upstreamProvider || extractOpenRouterUpstream(model.id);
      if (!openRouterGroups.has(upstream)) {
        openRouterGroups.set(upstream, {
          id: upstream,
          label: model.upstreamProviderLabel || upstreamProviderLabel(upstream),
          models: []
        });
      }
      openRouterGroups.get(upstream).models.push(model);
    } else {
      const provider = model.provider || "other";
      if (!directGroups.has(provider)) {
        directGroups.set(provider, {
          kind: "direct",
          provider,
          label: providerDisplayLabel(provider),
          models: []
        });
      }
      directGroups.get(provider).models.push(model);
    }
  }
  const result = [];
  result.push(...[...directGroups.values()]
    .sort((a, b) => providerGroupRank(a.provider) - providerGroupRank(b.provider) || a.label.localeCompare(b.label))
    .map((group) => ({ ...group, models: group.models.sort(comparePickerModels) })));
  if (openRouterGroups.size) {
    result.push({
      provider: "openrouter",
      upstreams: [...openRouterGroups.values()]
        .sort((a, b) => upstreamRank(a.id) - upstreamRank(b.id) || a.label.localeCompare(b.label))
        .map((group) => ({ ...group, models: group.models.sort(comparePickerModels) }))
    });
  }
  return result;
}

function comparePickerModels(a, b) {
  if (a.source !== b.source) return a.source === "discovered" ? -1 : 1;
  return a.label.localeCompare(b.label);
}

function extractOpenRouterUpstream(id) {
  return String(id || "").split("/")[0] || "other";
}

function providerDisplayLabel(provider) {
  const labels = {
    openai: "OpenAI",
    ollama: "Ollama"
  };
  return labels[provider] || provider.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function providerGroupRank(provider) {
  const order = ["openai", "ollama"];
  const index = order.indexOf(provider);
  return index === -1 ? 50 : index;
}

function upstreamRank(upstream) {
  const order = ["openai", "anthropic", "google", "meta-llama", "deepseek", "x-ai", "mistralai", "qwen"];
  const index = order.indexOf(upstream);
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
  return labels[upstream] || upstream;
}

function bindModelOptionClicks(menu, onSelect) {
  menu.querySelectorAll(".model-option").forEach((button) => {
    button.addEventListener("click", () => onSelect(button.dataset.value));
  });
}

function createDefaultCouncilSeats() {
  const model = normalizeModelValue(els.model?.value || state.defaultModel);
  const pack = getSelectedCouncilPack();
  const personaIds = pack?.personaIds?.length ? pack.personaIds : state.personas.slice(0, 3).map((persona) => persona.id);
  return personaIds.slice(0, 3).map((personaId) => ({
    personaId,
    model
  }));
}

function syncCouncilSeatModelsToPrimary() {
  const model = normalizeModelValue(els.model?.value || state.defaultModel);
  const seats = state.councilSeats.length ? state.councilSeats : createDefaultCouncilSeats();
  state.councilSeats = seats.map((seat) => ({ ...seat, model }));
}

function syncCouncilSeatDefaults() {
  const currentModel = normalizeModelValue(els.model?.value || state.defaultModel);
  const existing = state.councilSeats.length ? state.councilSeats : createDefaultCouncilSeats();
  const usedPersonas = new Set();
  state.councilSeats = existing.slice(0, 3).map((seat, index) => {
    let personaId = state.personas.some((persona) => persona.id === seat.personaId) ? seat.personaId : state.personas[index]?.id;
    if (usedPersonas.has(personaId)) personaId = state.personas.find((persona) => !usedPersonas.has(persona.id))?.id || personaId;
    usedPersonas.add(personaId);
    return {
      personaId,
      model: normalizeModelValue(seat.model || currentModel)
    };
  });

  for (const persona of state.personas) {
    if (state.councilSeats.length >= 3) break;
    if (usedPersonas.has(persona.id)) continue;
    state.councilSeats.push({ personaId: persona.id, model: currentModel });
    usedPersonas.add(persona.id);
  }
  const maxSeats = Math.min(3, state.councilSeats.length || 3);
  state.councilSeatCount = Math.min(maxSeats, Math.max(2, state.councilSeatCount || maxSeats));
  ensureCouncilActivePersona();
}

function getSelectedCouncilPack() {
  return state.councilPacks.find((pack) => pack.id === state.councilPackId) || state.councilPacks[0] || null;
}

function applyCouncilPack(packId) {
  const pack = state.councilPacks.find((item) => item.id === packId);
  if (!pack) return;
  const model = normalizeModelValue(els.model?.value || state.defaultModel);
  state.councilPackId = pack.id;
  state.councilSeatCount = Math.min(3, Math.max(2, pack.personaIds.length));
  state.councilSeats = pack.personaIds.slice(0, 3).map((personaId) => ({ personaId, model }));
  state.councilActivePersonaId = CHAIRMAN_PERSONA_ID;
  renderCouncilPanel();
  renderMessages(false);
}

function ensureCouncilActivePersona() {
  const activePersonaIds = state.councilSeats
    .slice(0, state.councilSeatCount)
    .map((seat) => seat.personaId)
    .filter(Boolean);
  const availableIds = [CHAIRMAN_PERSONA_ID, ...activePersonaIds];
  if (!activePersonaIds.length) return;
  if (!availableIds.includes(state.councilActivePersonaId)) {
    state.councilActivePersonaId = CHAIRMAN_PERSONA_ID;
  }
}

function renderCouncilPanel() {
  if (!els.councilPanel) return;
  syncCouncilSeatDefaults();
  const activeSeats = state.councilSeats.slice(0, state.councilSeatCount);
  els.councilPanel.innerHTML = `
    <div class="council-panel-header">
      <div>
        <strong>Council seats</strong>
        <p>${escapeHtml(getSelectedCouncilPack()?.description || "Choose the advisory lens for this run.")}</p>
      </div>
      <div class="council-panel-actions">
        <label>
          <span class="visually-hidden">Seat count</span>
          <select id="council-seat-count" ${state.isStreaming ? "disabled" : ""}>
            <option value="2"${state.councilSeatCount === 2 ? " selected" : ""}>2 seats</option>
            <option value="3"${state.councilSeatCount === 3 ? " selected" : ""}>3 seats</option>
          </select>
        </label>
        <button class="council-disable-button" type="button" data-action="disable-council" ${state.isStreaming ? "disabled" : ""}>Single response</button>
      </div>
    </div>
    <label class="council-pack-field">
      <span>Pack</span>
      <select id="council-pack-select" ${state.isStreaming ? "disabled" : ""}>
        ${renderCouncilPackOptions()}
      </select>
    </label>
    <label class="council-orchestrator-field">
      <span>Orchestrator</span>
      <select id="council-orchestrator-model" ${state.isStreaming ? "disabled" : ""}>
        ${renderNativeModelOptions(getSelectedOrchestratorModel())}
      </select>
      <small>Used for Briefing Partner and Chairman Brief</small>
    </label>
    ${activeSeats.map((seat, index) => `
      <div class="council-seat">
        <span class="council-seat-number">${index + 1}</span>
        <label>
          <span>Persona</span>
          <select class="council-persona-select" data-index="${index}" ${state.isStreaming ? "disabled" : ""}>
            ${renderPersonaOptions(seat.personaId)}
          </select>
        </label>
        <label>
          <span>Model</span>
          <select class="council-model-select" data-index="${index}" ${state.isStreaming ? "disabled" : ""}>
            ${renderNativeModelOptions(seat.model)}
          </select>
        </label>
      </div>
    `).join("")}
  `;
}

function renderCouncilPackOptions() {
  const custom = state.councilPackId ? "" : `<option value="" selected>Custom</option>`;
  return custom + state.councilPacks.map((pack) => {
    const selected = pack.id === state.councilPackId ? " selected" : "";
    return `<option value="${escapeHtml(pack.id)}"${selected}>${escapeHtml(pack.name)}</option>`;
  }).join("");
}

function renderPersonaOptions(selectedPersonaId) {
  return state.personas.map((persona) => {
    const selected = persona.id === selectedPersonaId ? " selected" : "";
    return `<option value="${escapeHtml(persona.id)}"${selected}>${escapeHtml(persona.shortName || persona.name)}</option>`;
  }).join("");
}

function handleCouncilPanelChange(event) {
  if (state.isStreaming) return;
  const target = event.target;
  if (target.id === "council-seat-count") {
    state.councilSeatCount = Math.min(3, Math.max(2, Number(target.value) || 3));
    ensureCouncilActivePersona();
    renderCouncilPanel();
    return;
  }

  if (target.id === "council-pack-select") {
    if (target.value) applyCouncilPack(target.value);
    return;
  }

  if (target.id === "council-orchestrator-model") {
    state.orchestratorModel = normalizeModelValue(target.value);
    renderCouncilPanel();
    return;
  }

  const index = Number(target.dataset.index);
  if (!Number.isInteger(index) || !state.councilSeats[index]) return;
  if (target.classList.contains("council-persona-select")) {
    state.councilPackId = "";
    state.councilSeats[index].personaId = target.value;
    dedupeCouncilPersonas(index);
    ensureCouncilActivePersona();
  } else if (target.classList.contains("council-model-select")) {
    state.councilSeats[index].model = normalizeModelValue(target.value);
  }
  renderCouncilPanel();
}

function handleCouncilViewToggle(event) {
  const button = event.target.closest("[data-council-view]");
  if (!button) return;
  event.stopPropagation();
  state.councilViewMode = button.dataset.councilView === "tabs" ? "tabs" : "columns";
  syncCouncilModeUi();
  renderMessages(false);
}

function handleCouncilPanelClick(event) {
  const disable = event.target.closest("[data-action='disable-council']");
  if (!disable || state.isStreaming) return;
  state.compareMode = false;
  state.councilPanelOpen = false;
  syncCouncilModeUi();
}

function dedupeCouncilPersonas(changedIndex) {
  const used = new Set();
  for (let index = 0; index < state.councilSeats.length; index += 1) {
    const seat = state.councilSeats[index];
    if (!used.has(seat.personaId)) {
      used.add(seat.personaId);
      continue;
    }
    if (index === changedIndex) {
      const duplicateIndex = state.councilSeats.findIndex((other, otherIndex) => otherIndex !== index && other.personaId === seat.personaId);
      const replacement = state.personas.find((persona) => !used.has(persona.id));
      if (replacement && duplicateIndex !== -1) {
        state.councilSeats[duplicateIndex].personaId = replacement.id;
        used.add(replacement.id);
      }
      continue;
    }
    const replacement = state.personas.find((persona) => !used.has(persona.id));
    if (replacement) {
      seat.personaId = replacement.id;
      used.add(replacement.id);
    }
  }
}

function getSelectedSeats() {
  if (!state.compareMode) {
    return [{ model: normalizeModelValue(els.model.value), personaId: null }];
  }
  syncCouncilSeatDefaults();
  return state.councilSeats.slice(0, state.councilSeatCount).map((seat) => ({
    model: normalizeModelValue(seat.model || els.model.value),
    personaId: seat.personaId
  }));
}

function getSelectedOrchestratorModel() {
  state.orchestratorModel = normalizeModelValue(state.orchestratorModel || els.model?.value || state.defaultModel);
  return state.orchestratorModel;
}

function messageToSeat(message) {
  return {
    model: normalizeModelValue(message.model || els.model.value),
    personaId: message.personaId || null
  };
}

function getPersonaName(personaId) {
  if (personaId === BRIEFING_PERSONA_ID) return BRIEFING_PERSONA_NAME;
  if (personaId === CHAIRMAN_PERSONA_ID) return CHAIRMAN_PERSONA_NAME;
  const persona = state.personas.find((item) => item.id === personaId);
  return persona?.name || "";
}

function renderConversationsLegacy() {
  const query = els.search.value.trim().toLowerCase();
  const conversations = state.conversations.filter((conversation) => conversation.title.toLowerCase().includes(query));
  els.conversationList.innerHTML = conversations.map((conversation) => {
    const active = conversation.id === state.activeConversation?.id ? " active" : "";
    const updated = new Date(conversation.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" });
    return `
      <button class="conversation-item${active}" type="button" data-id="${escapeHtml(conversation.id)}">
        <strong>${escapeHtml(conversation.title)}</strong>
        <span>${escapeHtml(conversation.model || "")} · ${updated}</span>
      </button>
    `;
  }).join("");

  els.conversationList.querySelectorAll(".conversation-item").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.isStreaming) loadConversation(button.dataset.id);
    });
  });
}

function renderMessages(scroll = true) {
  document.querySelector(".chat-shell")?.classList.toggle("empty", state.messages.length === 0);
  if (!state.messages.length) {
    els.messages.innerHTML = `
      <div class="empty-state">
        <div>
          <h1>How can I help, Ravneet?</h1>
          <p>Start a conversation or attach files.</p>
        </div>
      </div>
    `;
    updateActionState();
    return;
  }

  els.messages.innerHTML = groupMessagesForRender(state.messages).map((item) => {
    if (item.type === "compare") return renderCompareGroup(item.messages);
    return renderSingleMessage(item.message);
  }).join("");

  if (scroll) els.messages.scrollTop = els.messages.scrollHeight;
  updateActionState();
}

function groupMessagesForRender(messages) {
  const groups = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.turnId) {
      groups.push({ type: "single", message });
      continue;
    }
    const candidates = [message];
    while (
      index + 1 < messages.length &&
      messages[index + 1].role === "assistant" &&
      messages[index + 1].turnId === message.turnId
    ) {
      candidates.push(messages[index + 1]);
      index += 1;
    }
    if (candidates.length > 1) {
      groups.push({ type: "compare", messages: candidates });
    } else {
      groups.push({ type: "single", message });
    }
  }
  return groups;
}

function renderSingleMessage(message) {
  const roleLabel = message.role === "assistant" && message.personaId ? getPersonaName(message.personaId) : message.role;
  return `
    <article class="message ${escapeHtml(message.role)}">
      <div class="message-role">${escapeHtml(roleLabel)}</div>
      <div class="message-body">
        ${renderMarkdown(message.content || statusText(message))}
        ${renderMessageFailure(message)}
        ${message.files?.length ? `<div class="message-files">${message.files.map(renderFileTile).join("")}</div>` : ""}
        ${renderMessageActions(message)}
        ${renderMessageUsage(message)}
      </div>
    </article>
  `;
}

function renderCompareGroup(messages) {
  const sorted = [...messages].sort((a, b) => Number(a.candidateIndex || 0) - Number(b.candidateIndex || 0));
  if (state.councilViewMode === "tabs") return renderCouncilTabbedGroup(sorted);
  const { chairman, experts } = splitChairmanMessages(sorted);
  return `
    <article class="compare-group council-columns-group columns-${experts.length}" aria-label="Council responses">
      ${chairman ? renderCouncilPane(chairman, "council-chairman-pane") : ""}
      ${experts.map((message) => renderCouncilPane(message)).join("")}
    </article>
  `;
}

function renderCouncilPane(message, extraClass = "") {
  return `
        <section class="compare-pane ${escapeHtml(extraClass)} ${escapeHtml(message.status || "")}">
          <div class="compare-pane-header">
            <span>${escapeHtml(message.personaName || getPersonaName(message.personaId) || getModelLabel(message.model))}</span>
            <small>${escapeHtml([getModelLabel(message.model), statusBadge(message)].filter(Boolean).join(" / "))}</small>
          </div>
          <div class="message-body">
            ${renderMarkdown(message.content || statusText(message))}
            ${renderMessageFailure(message)}
            ${renderMessageActions(message)}
            ${renderMessageUsage(message)}
          </div>
        </section>
  `;
}

function renderCouncilTabbedGroup(messages) {
  const selected = getSelectedCouncilTabMessage(messages);
  return `
    <article class="compare-group council-tabbed-group" aria-label="Council responses">
      <div class="council-response-tabs" role="tablist" aria-label="Council personas">
        ${messages.map((message, index) => {
          const key = councilTabKey(message, index);
          const selectedTab = key === councilTabKey(selected);
          return `
            <button
              class="council-response-tab${selectedTab ? " active" : ""}"
              type="button"
              role="tab"
              aria-selected="${selectedTab ? "true" : "false"}"
              data-persona-id="${escapeHtml(message.personaId || "")}"
              data-tab-key="${escapeHtml(key)}"
            >
              <span>${escapeHtml(message.personaName || getPersonaName(message.personaId) || getModelLabel(message.model))}</span>
              ${statusBadge(message) ? `<small>${escapeHtml(statusBadge(message))}</small>` : ""}
            </button>
          `;
        }).join("")}
      </div>
      <section class="compare-pane council-tab-pane ${escapeHtml(selected.status || "")}">
        <div class="compare-pane-header">
          <span>${escapeHtml(selected.personaName || getPersonaName(selected.personaId) || getModelLabel(selected.model))}</span>
          <small>${escapeHtml([getModelLabel(selected.model), statusBadge(selected)].filter(Boolean).join(" / "))}</small>
        </div>
        <div class="message-body">
          ${renderMarkdown(selected.content || statusText(selected))}
          ${renderMessageFailure(selected)}
          ${renderMessageActions(selected)}
          ${renderMessageUsage(selected)}
        </div>
      </section>
    </article>
  `;
}

function getSelectedCouncilTabMessage(messages) {
  return messages.find((message, index) => councilTabKey(message, index) === state.councilActivePersonaId) ||
    messages.find((message) => message.personaId === state.councilActivePersonaId) ||
    messages.find(isChairmanMessage) ||
    messages[0];
}

function councilTabKey(message, index = Number(message.candidateIndex || 0)) {
  return message.personaId || `candidate-${index}`;
}

function splitChairmanMessages(messages) {
  return {
    chairman: messages.find(isChairmanMessage),
    experts: messages.filter((message) => !isChairmanMessage(message))
  };
}

function isChairmanMessage(message) {
  return message.personaId === CHAIRMAN_PERSONA_ID;
}

function statusBadge(message) {
  if (message.status === "streaming") return "Streaming";
  if (message.status === "failed") return message.content?.trim() ? "Stopped early" : "Failed";
  if (message.status === "cancelled") return "Stopped";
  return "";
}

function renderAttachments() {
  els.attachmentList.innerHTML = state.pendingFiles.map((file) => `
    <button class="file-chip pending-file-chip" type="button" data-id="${escapeHtml(file.id)}" title="Remove file">${escapeHtml(file.filename)} x</button>
  `).join("");

  els.attachmentList.querySelectorAll(".file-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.pendingFiles = state.pendingFiles.filter((file) => file.id !== chip.dataset.id);
      renderAttachments();
    });
  });
}

function renderMessageActions(message) {
  if (message.role !== "assistant" || message.status === "streaming" || !message.content?.trim()) return "";
  return `
    <div class="message-actions" data-message-id="${escapeHtml(message.id)}">
      <button class="message-action" type="button" data-action="copy" title="Copy response" aria-label="Copy response">
        <svg class="copy-action-icon" viewBox="0 0 24 24" aria-hidden="true"><rect class="copy-back" x="4" y="4" width="12" height="12" rx="2"/><rect class="copy-front" x="8" y="8" width="12" height="12" rx="2"/></svg>
      </button>
      <button class="message-action" type="button" data-action="share" title="Download markdown" aria-label="Download markdown">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/></svg>
      </button>
      <button class="message-action" type="button" data-action="regenerate" title="Regenerate response" aria-label="Regenerate response">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 0-15.3-6.4L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.3 6.4L21 16"/><path d="M16 16h5v5"/></svg>
      </button>
    </div>
  `;
}

function renderMessageFailure(message) {
  if (message.status !== "failed" || !message.error) return "";
  return `<div class="message-failure">${escapeHtml(message.error)}</div>`;
}

function renderMessageUsage(message) {
  const usage = normalizeUsage(message.usage);
  if (!usage) return "";
  return `<div class="message-usage">${escapeHtml(usage)}</div>`;
}

async function handleMessagesClick(event) {
  const tab = event.target.closest(".council-response-tab");
  if (tab) {
    state.councilActivePersonaId = tab.dataset.personaId || tab.dataset.tabKey || "";
    syncCouncilModeUi();
    renderMessages(false);
    return;
  }

  const button = event.target.closest(".message-action");
  if (!button) return;
  const messageId = button.closest(".message-actions")?.dataset.messageId;
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) return;

  if (button.dataset.action === "copy") {
    await copyAssistantResponse(message, button);
  } else if (button.dataset.action === "share") {
    downloadAssistantResponse(message);
  } else if (button.dataset.action === "regenerate") {
    await regenerateLast();
  }
}

async function copyAssistantResponse(message, button) {
  await navigator.clipboard.writeText(message.content || "");
  const originalTitle = button.title;
  button.title = "Copied";
  setTimeout(() => {
    button.title = originalTitle;
  }, 1200);
}

function downloadAssistantResponse(message) {
  const conversationTitle = state.activeConversation?.title || "conversation";
  const body = [
    `# ${conversationTitle}`,
    "",
    message.personaId ? `Persona: ${message.personaName || getPersonaName(message.personaId)}` : "",
    `Model: ${message.model || state.activeConversation?.model || ""}`,
    `Created: ${new Date(message.createdAt || Date.now()).toLocaleString()}`,
    "",
    message.content || ""
  ].join("\n");
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(conversationTitle)}-response.md`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function setStreaming(value) {
  state.isStreaming = value;
  els.send.hidden = value;
  els.stop.hidden = !value;
  els.input.disabled = value;
  els.attach.disabled = value;
  els.model.disabled = value;
  els.compareToggle.disabled = value;
  els.compareModel.disabled = value;
  renderCouncilPanel();
  updateActionState();
  els.connection.textContent = value ? (state.compareMode ? "Council streaming" : "Streaming") : "Ready";
}

function updateActionState() {
  els.regenerate.disabled = state.isStreaming || !state.messages.some((message) => message.role === "user");
  els.modelPickerButton.disabled = state.isStreaming;
  els.compareModelPickerButton.disabled = state.isStreaming;
  syncCouncilModeUi();
  document.querySelector(".chat-shell")?.classList.toggle("empty", state.messages.length === 0);
}

function autoresize() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(180, els.input.scrollHeight)}px`;
}

function focusComposer() {
  setTimeout(() => els.input.focus(), 0);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function renderMarkdown(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const parts = [];
  const fencePattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = fencePattern.exec(source)) !== null) {
    if (match.index > lastIndex) {
      parts.push(renderMarkdownBlocks(source.slice(lastIndex, match.index)));
    }
    const language = match[1]?.trim();
    const label = language ? `<span class="code-language">${escapeHtml(language)}</span>` : "";
    parts.push(`<pre>${label}<code>${escapeHtml(match[2].trim())}</code></pre>`);
    lastIndex = fencePattern.lastIndex;
  }

  if (lastIndex < source.length) {
    parts.push(renderMarkdownBlocks(source.slice(lastIndex)));
  }

  return parts.join("");
}

function renderMarkdownBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  let quote = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    blocks.push(`<${list.type}>${list.items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${list.type}>`);
    list = null;
  };

  const flushQuote = () => {
    if (!quote.length) return;
    blocks.push(`<blockquote>${quote.map((line) => `<p>${renderInlineMarkdown(line)}</p>`).join("")}</blockquote>`);
    quote = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    if (isTableStart(lines, index)) {
      flushParagraph();
      flushList();
      flushQuote();
      const tableLines = [lines[index], lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      index -= 1;
      blocks.push(renderMarkdownTable(tableLines));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = Math.min(heading[1].length + 1, 6);
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = line.match(/^[-*+]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const type = ordered ? "ol" : "ul";
      if (!list || list.type !== type) flushList();
      list ||= { type, items: [] };
      list.items.push((unordered || ordered)[1]);
      continue;
    }

    const quoted = line.match(/^>\s?(.+)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  flushQuote();
  return blocks.join("");
}

function renderMarkdownTable(lines) {
  const header = splitTableRow(lines[0]);
  const rows = lines.slice(2).map(splitTableRow).filter((row) => row.length);
  if (!header.length || !rows.length) return `<p>${renderInlineMarkdown(lines.join(" "))}</p>`;
  return `
    <div class="markdown-table-wrap">
      <table>
        <thead><tr>${header.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((row) => `<tr>${header.map((_, index) => `<td>${renderInlineMarkdown(row[index] || "")}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>
  `;
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isTableStart(lines, index) {
  return Boolean(
    lines[index]?.includes("|") &&
    lines[index + 1]?.trim().match(/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/)
  );
}

function renderInlineMarkdown(text) {
  const codeSpans = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@CODE${codeSpans.length}@@`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });

  html = html.replace(/\[([^\]]+)]\(([^)\s]+)\)/g, (_, label, url) => {
    const safeUrl = sanitizeUrl(url);
    return safeUrl ? `<a href="${safeUrl}" target="_blank" rel="noreferrer">${label}</a>` : label;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");

  codeSpans.forEach((code, index) => {
    html = html.replace(`@@CODE${index}@@`, code);
  });
  return html;
}

function sanitizeUrl(url) {
  const decoded = url.replaceAll("&amp;", "&");
  try {
    const parsed = new URL(decoded, window.location.origin);
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return "";
    return escapeHtml(parsed.href);
  } catch {
    return "";
  }
}

function statusText(message) {
  if (message.status === "streaming") return "Thinking...";
  if (message.status === "cancelled") return "Stopped.";
  if (message.status === "failed") return message.error || "The request failed.";
  return "";
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return "";
  const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens ?? usage.outputTokens;
  const total = usage.total_tokens ?? usage.totalTokens ?? (Number(input || 0) + Number(output || 0) || null);
  const parts = [];
  if (Number.isFinite(Number(input))) parts.push(`${formatCount(input)} in`);
  if (Number.isFinite(Number(output))) parts.push(`${formatCount(output)} out`);
  if (!parts.length && Number.isFinite(Number(total))) parts.push(`${formatCount(total)} total`);
  return parts.length ? `${parts.join(" / ")} tokens` : "";
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function shortId(id) {
  return id.slice(0, 8);
}

function indexFiles(files) {
  return new Map(files.map((file) => [file.id, file]));
}

function renderFileTile(fileId) {
  const file = state.filesById.get(fileId);
  if (!file) {
    return `<span class="file-tile"><span class="file-icon">?</span><span><strong>Attachment</strong><small>${escapeHtml(shortId(fileId))}</small></span></span>`;
  }
  return `
    <a class="file-tile" href="/api/files/${encodeURIComponent(file.id)}" target="_blank" rel="noreferrer">
      <span class="file-icon">${escapeHtml(fileIconLabel(file))}</span>
      <span>
        <strong>${escapeHtml(file.filename)}</strong>
        <small>${escapeHtml(fileMeta(file))}</small>
      </span>
    </a>
  `;
}

function fileIconLabel(file) {
  const mime = String(file.mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "IMG";
  if (mime.includes("pdf")) return "PDF";
  if (mime.includes("json")) return "JSN";
  if (mime.includes("csv") || mime.includes("spreadsheet") || mime.includes("excel")) return "CSV";
  if (mime.includes("word") || mime.includes("document")) return "DOC";
  return "FILE";
}

function fileMeta(file) {
  return [compactMime(file.mimeType), formatBytes(file.size)].filter(Boolean).join(" / ");
}

function compactMime(mimeType) {
  const mime = String(mimeType || "");
  if (!mime) return "";
  if (mime.startsWith("image/")) return mime.replace("image/", "").toUpperCase();
  if (mime.includes("pdf")) return "PDF";
  if (mime.includes("json")) return "JSON";
  if (mime.includes("csv")) return "CSV";
  if (mime.startsWith("text/")) return mime.replace("text/", "").toUpperCase();
  return mime.split("/").pop()?.toUpperCase() || "";
}

function formatBytes(bytes) {
  const size = Number(bytes || 0);
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function slugify(value) {
  return String(value || "conversation")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "conversation";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderMemoryPanel() {
  const memory = state.memory || {};
  els.memoryEnabled.checked = memory.enabled !== false;
  els.memorySummary.value = memory.summary || "";
  els.memoryFacts.value = listToLines(memory.facts);
  els.memoryDecisions.value = listToLines(memory.decisions);
  els.memoryQuestions.value = listToLines(memory.openQuestions);
  const updated = memory.updatedAt
    ? new Date(memory.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "not updated";
  const tokens = Number(memory.estimatedTokens || 0).toLocaleString();
  const messages = Number(memory.messageCount || 0).toLocaleString();
  els.memoryStats.textContent = `${messages} messages tracked, ${tokens} estimated tokens, updated ${updated}`;
}

function linesToList(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function listToLines(value) {
  return Array.isArray(value) ? value.map((item) => `- ${item}`).join("\n") : "";
}

function normalizeModelValue(value) {
  const model = state.models.find((item) => item.key === value) ||
    state.models.find((item) => item.id === value);
  return model?.key || state.defaultModel;
}

function getModelLabel(value) {
  const model = state.models.find((item) => item.key === value) ||
    state.models.find((item) => item.id === value);
  return model?.label || value || "";
}

function compactModelLabel(model) {
  return model.label
    .replace(/^OpenRouter\s+/i, "")
    .replace(/^GPT-/i, "GPT ")
    .replace(/\bGpt\b/g, "GPT")
    .replace(/\s+mini$/i, " mini");
}

function setModelValue(value) {
  els.model.value = normalizeModelValue(value);
  syncModelPicker();
}

function syncModelPicker() {
  const selected = state.models.find((model) => model.key === els.model.value) ||
    state.models.find((model) => model.id === els.model.value);
  els.modelPickerLabel.textContent = selected ? compactModelLabel(selected) : "Model";
  els.modelPickerMenu.querySelectorAll(".model-option").forEach((option) => {
    option.classList.toggle("active", option.dataset.value === els.model.value);
    option.setAttribute("aria-selected", option.dataset.value === els.model.value ? "true" : "false");
  });
}

function setCompareModelValue(value) {
  const normalized = normalizeModelValue(value);
  state.compareModel = normalized === els.model.value ? getFallbackCompareModel(els.model.value) : normalized;
  els.compareModel.value = state.compareModel;
  syncCompareModelPicker();
}

function syncCompareModelPicker() {
  const selected = state.models.find((model) => model.key === els.compareModel.value) ||
    state.models.find((model) => model.id === els.compareModel.value);
  els.compareModelPickerLabel.textContent = selected ? compactModelLabel(selected) : "Compare";
  els.compareModelPickerMenu.querySelectorAll(".model-option").forEach((option) => {
    option.classList.toggle("active", option.dataset.value === els.compareModel.value);
    option.setAttribute("aria-selected", option.dataset.value === els.compareModel.value ? "true" : "false");
  });
}

function getFallbackCompareModel(primaryModel) {
  return state.models.find((model) => model.key !== primaryModel)?.key || primaryModel || state.defaultModel;
}

function toggleCompareMode(event) {
  event?.stopPropagation();
  if (state.isStreaming) return;
  if (!state.compareMode) {
    state.compareMode = true;
    state.councilPanelOpen = true;
    ensureCouncilActivePersona();
  } else {
    state.councilPanelOpen = !state.councilPanelOpen;
  }
  syncCouncilModeUi();
  renderCouncilPanel();
  closeModelPicker();
  closeCompareModelPicker();
}

function syncCouncilModeUi() {
  els.compareToggle.setAttribute("aria-pressed", state.compareMode ? "true" : "false");
  els.compareToggle.classList.toggle("active", state.compareMode);
  els.compareToggle.textContent = state.compareMode ? "Council on" : "Council";
  els.councilViewToggle.hidden = !state.compareMode;
  els.councilViewToggle.querySelectorAll("[data-council-view]").forEach((button) => {
    const active = button.dataset.councilView === state.councilViewMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  els.councilPanel.hidden = !(state.compareMode && state.councilPanelOpen);
  positionCouncilPanel();
}

function positionCouncilPanel() {
  if (!els.councilPanel || els.councilPanel.hidden) return;
  requestAnimationFrame(() => {
    if (els.councilPanel.hidden) return;
    const composerRect = els.composer.getBoundingClientRect();
    const margin = 16;
    const gap = 14;
    const spaceAbove = Math.max(0, composerRect.top - margin - gap);
    const spaceBelow = Math.max(0, window.innerHeight - composerRect.bottom - margin - gap);
    const preferBelow = spaceBelow > spaceAbove;
    const available = preferBelow ? spaceBelow : spaceAbove;
    els.councilPanel.classList.toggle("below", preferBelow);
    els.councilPanel.classList.toggle("above", !preferBelow);
    els.councilPanel.style.maxHeight = `${Math.max(80, Math.min(620, Math.floor(available)))}px`;
  });
}

function toggleModelPicker(event) {
  event.stopPropagation();
  if (state.isStreaming) return;
  const willOpen = els.modelPickerMenu.hidden;
  els.modelPickerMenu.hidden = !willOpen;
  els.modelPickerButton.setAttribute("aria-expanded", willOpen ? "true" : "false");
}

function closeModelPicker() {
  els.modelPickerMenu.hidden = true;
  els.modelPickerButton.setAttribute("aria-expanded", "false");
}

function toggleCompareModelPicker(event) {
  event.stopPropagation();
  if (state.isStreaming) return;
  const willOpen = els.compareModelPickerMenu.hidden;
  closeModelPicker();
  els.compareModelPickerMenu.hidden = !willOpen;
  els.compareModelPickerButton.setAttribute("aria-expanded", willOpen ? "true" : "false");
}

function closeCompareModelPicker() {
  els.compareModelPickerMenu.hidden = true;
  els.compareModelPickerButton.setAttribute("aria-expanded", "false");
}

function closeModelPickerOnOutsideClick(event) {
  if (!els.modelPicker.contains(event.target)) closeModelPicker();
  if (!els.compareModelPicker.contains(event.target)) closeCompareModelPicker();
  if (
    state.compareMode &&
    state.councilPanelOpen &&
    !els.councilPanel.contains(event.target) &&
    !els.compareToggle.contains(event.target)
  ) {
    state.councilPanelOpen = false;
    syncCouncilModeUi();
  }
}

function closeModelPickerOnEscape(event) {
  if (event.key === "Escape") {
    closeModelPicker();
    closeCompareModelPicker();
    if (state.councilPanelOpen) {
      state.councilPanelOpen = false;
      syncCouncilModeUi();
    }
  }
}

function renderConversations() {
  const query = els.search.value.trim().toLowerCase();
  const conversations = state.conversations.filter((conversation) => conversation.title.toLowerCase().includes(query));
  els.conversationList.innerHTML = conversations.map((conversation) => {
    const active = conversation.id === state.activeConversation?.id ? " active" : "";
    const updated = new Date(conversation.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" });
    return `
      <button class="conversation-item${active}" type="button" data-id="${escapeHtml(conversation.id)}">
        <strong>${escapeHtml(conversation.title)}</strong>
        <span>${escapeHtml(getModelLabel(conversation.model))} / ${updated}</span>
      </button>
    `;
  }).join("");

  els.conversationList.querySelectorAll(".conversation-item").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.isStreaming) loadConversation(button.dataset.id);
    });
  });
}

function findLastIndex(items, predicate) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index], index)) return index;
  }
  return -1;
}
