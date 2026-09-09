// public/app.js
import { createStore } from "./store.js";
import {
  initApi, usesProxy, getApiKey, setApiKey, getModel, setModel,
  listModels, countTokens, transcribe, buildContents, stream
} from "./api.js";

const $ = (id) => document.getElementById(id);
const els = {
  gate: $("authGate"), signIn: $("signIn"), signOut: $("signOut"), userEmail: $("userEmail"),
  sidebar: $("sidebar"), toggleSidebar: $("toggleSidebar"), newChat: $("newChat"), chatList: $("chatList"),
  messages: $("messages"), composer: $("composer"), input: $("input"), send: $("send"), modelName: $("modelName"),
  toggleSettings: $("toggleSettings"), settingsPanel: $("settingsPanel"), themeOptions: $("themeOptions"),
  modelSelect: $("modelSelect"), memoryBar: $("memoryBar"), memoryText: $("memoryText"),
  apiKeySection: $("apiKeySection"), apiKey: $("apiKey"),
  attach: $("attach"), fileInput: $("fileInput"), attachments: $("attachments"),
  mic: $("mic"), status: $("status")
};

await initApi();
const store = await createStore();

let chatId = null;
let messages = [];
let pendingFiles = [];
let modelLimits = {};
let busy = false;

const setStatus = (text = "") => { els.status.textContent = text; };

// MARK: - Tema

const THEME_KEY = "gemini-chat:theme";

function applyTheme(theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  for (const b of els.themeOptions.children) {
    b.setAttribute("aria-pressed", String(b.dataset.theme === theme));
  }
}

applyTheme(localStorage.getItem(THEME_KEY) ?? "system");
els.themeOptions.onclick = (e) => {
  const theme = e.target.closest("button")?.dataset.theme;
  if (theme) applyTheme(theme);
};

// MARK: - Ajustes

els.modelName.textContent = getModel() + (store.local && usesProxy() ? " · local" : "");

// El campo de key solo aparece si no hay proxy que la guarde por nosotros.
if (!usesProxy()) {
  els.apiKeySection.hidden = false;
  els.apiKey.value = getApiKey();
  els.apiKey.oninput = () => {
    setApiKey(els.apiKey.value);
    loadModels();
  };
}

els.toggleSettings.onclick = (e) => {
  e.stopPropagation();
  els.settingsPanel.hidden = !els.settingsPanel.hidden;
  if (!els.settingsPanel.hidden) refreshMemory();
};

document.addEventListener("click", (e) => {
  if (!els.settingsPanel.hidden && !els.settingsPanel.contains(e.target)) {
    els.settingsPanel.hidden = true;
  }
});

async function loadModels() {
  if (!usesProxy() && !getApiKey()) return;
  try {
    const models = await listModels();
    modelLimits = Object.fromEntries(models.map((m) => [m.id, m.inputTokenLimit]));
    els.modelSelect.replaceChildren(...models.map((m) => {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.label;
      o.selected = m.id === getModel();
      return o;
    }));
  } catch (err) {
    setStatus(err.message);
  }
}

els.modelSelect.onchange = () => {
  setModel(els.modelSelect.value);
  els.modelName.textContent = getModel() + (store.local && usesProxy() ? " · local" : "");
  refreshMemory();
};

loadModels();

// MARK: - Memoria

async function refreshMemory() {
  if (!messages.length) {
    els.memoryBar.style.width = "0%";
    els.memoryText.textContent = "Sin mensajes todavía.";
    return;
  }

  const limit = modelLimits[getModel()] ?? 1048576;
  els.memoryText.textContent = `${messages.length} mensajes · contando tokens...`;

  try {
    const used = await countTokens(buildContents(messages, "", []));
    els.memoryBar.style.width = `${Math.min(100, (used / limit) * 100).toFixed(2)}%`;
    els.memoryText.textContent =
      `${messages.length} mensajes · ${used.toLocaleString("es")} de ${limit.toLocaleString("es")} tokens`;
  } catch {
    els.memoryText.textContent = `${messages.length} mensajes`;
  }
}

// MARK: - Chats

function newChat() {
  chatId = null;
  messages = [];
  pendingFiles = [];
  renderAttachments();
  renderMessages();
  markActive();
  setStatus();
  els.input.focus();
}

els.newChat.onclick = newChat;
els.signIn.onclick = () => store.signIn();
els.signOut.onclick = () => store.signOut();
els.toggleSidebar.onclick = () => els.sidebar.classList.toggle("collapsed");

store.onReady((authed) => {
  els.gate.classList.toggle("hidden", authed);
  els.userEmail.textContent = store.user?.email ?? "";
  if (!authed) return;
  store.onChats(renderChatList);
  newChat();
});

function renderChatList(chats) {
  els.chatList.replaceChildren(...chats.map(({ id, title }) => {
    const row = document.createElement("div");
    row.className = "chat-row";
    row.dataset.id = id;

    const open = document.createElement("button");
    open.className = "chat-item";
    open.textContent = title || "Nuevo chat";
    open.onclick = () => openChat(id);

    const actions = document.createElement("div");
    actions.className = "chat-actions";
    actions.append(
      iconButton("✎", "Renombrar", () => renameChat(id, title)),
      iconButton("✕", "Eliminar", () => deleteChat(id, title))
    );

    row.append(open, actions);
    return row;
  }));
  markActive();
}

function iconButton(glyph, label, onClick) {
  const b = document.createElement("button");
  b.textContent = glyph;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

async function renameChat(id, current) {
  const title = prompt("Nuevo nombre del chat:", current ?? "")?.trim();
  if (title) await store.rename(id, title);
}

async function deleteChat(id, title) {
  if (!confirm(`¿Eliminar "${title || "Nuevo chat"}"?`)) return;
  await store.remove(id);
  if (id === chatId) newChat();
}

async function openChat(id) {
  chatId = id;
  messages = await store.load(id);
  pendingFiles = [];
  renderAttachments();
  renderMessages();
  markActive();
  if (window.innerWidth <= 768) els.sidebar.classList.add("collapsed");
}

function markActive() {
  for (const el of els.chatList.children) el.classList.toggle("active", el.dataset.id === chatId);
}

// MARK: - Render

const escapeHtml = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Markdown mínimo: fences, inline code, bold, italic.
function renderMarkdown(text) {
  return text.split(/```/).map((part, i) => {
    if (i % 2 === 1) return `<pre><code>${escapeHtml(part.replace(/^[\w+#-]*\n/, ""))}</code></pre>`;
    return escapeHtml(part)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\s)\*([^*\n]+)\*/g, "$1<em>$2</em>");
  }).join("");
}

function bubbleFor(msg) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${msg.role === "user" ? "user" : "model"}`;
  const b = document.createElement("div");
  b.className = "bubble";

  const names = (msg.files ?? []).map((f) => `📎 ${f.name}`).join("\n");
  if (msg.role === "user") b.textContent = [names, msg.text].filter(Boolean).join("\n");
  else b.innerHTML = renderMarkdown(msg.text);

  wrap.append(b);
  return wrap;
}

function renderMessages() {
  els.messages.replaceChildren(...messages.map(bubbleFor));
  scrollToBottom();
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

// MARK: - Adjuntos

const MAX_FILE_BYTES = 15 * 1024 * 1024;

const toBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.split(",")[1]);
  reader.onerror = () => reject(new Error(`No se pudo leer ${file.name}`));
  reader.readAsDataURL(file);
});

els.attach.onclick = () => els.fileInput.click();

els.fileInput.onchange = async () => {
  for (const file of els.fileInput.files) {
    if (file.size > MAX_FILE_BYTES) {
      setStatus(`${file.name} supera los 15 MB`);
      continue;
    }
    pendingFiles.push({
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      data: await toBase64(file)
    });
  }
  els.fileInput.value = "";
  renderAttachments();
};

function renderAttachments() {
  els.attachments.replaceChildren(...pendingFiles.map((f, i) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    const name = document.createElement("span");
    name.textContent = f.name;
    chip.append(name, iconButton("✕", "Quitar", () => {
      pendingFiles.splice(i, 1);
      renderAttachments();
    }));
    return chip;
  }));
}

// MARK: - Dictado

let recorder = null;

els.mic.onclick = async () => {
  if (recorder?.state === "recording") {
    recorder.stop();
    return;
  }

  let mediaStream;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setStatus("Sin acceso al micrófono.");
    return;
  }

  const chunks = [];
  recorder = new MediaRecorder(mediaStream);
  recorder.ondataavailable = (e) => chunks.push(e.data);

  recorder.onstop = async () => {
    mediaStream.getTracks().forEach((t) => t.stop());
    els.mic.classList.remove("recording");
    setStatus("Transcribiendo...");
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      const base64 = await toBase64(blob);
      const text = await transcribe(base64, blob.type.split(";")[0]);
      els.input.value = [els.input.value.trim(), text].filter(Boolean).join(" ");
      els.input.dispatchEvent(new Event("input"));
      els.input.focus();
      setStatus();
    } catch (err) {
      setStatus(err.message);
    }
  };

  recorder.start();
  els.mic.classList.add("recording");
  setStatus("Grabando... pulsa de nuevo para parar.");
};

// MARK: - Envío

els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = `${els.input.scrollHeight}px`;
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

els.composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if ((!text && !pendingFiles.length) || busy) return;

  const files = pendingFiles;
  pendingFiles = [];
  renderAttachments();
  els.input.value = "";
  els.input.style.height = "auto";
  busy = true;
  els.send.disabled = true;
  setStatus();

  const history = messages.map(({ role, text, files }) => ({ role, text, files }));
  messages.push({ role: "user", text, ...(files.length ? { files } : {}) });
  els.messages.append(bubbleFor(messages.at(-1)));

  const reply = { role: "model", text: "" };
  messages.push(reply);
  const node = bubbleFor(reply);
  const bubble = node.querySelector(".bubble");
  bubble.classList.add("cursor");
  els.messages.append(node);
  scrollToBottom();

  try {
    for await (const chunk of stream({ history, message: text, files })) {
      reply.text += chunk;
      bubble.innerHTML = renderMarkdown(reply.text);
      scrollToBottom();
    }
  } catch (err) {
    reply.text ||= `Error: ${err.message}`;
    node.classList.add("error");
    bubble.innerHTML = renderMarkdown(reply.text);
  } finally {
    bubble.classList.remove("cursor");
    busy = false;
    els.send.disabled = false;
    chatId = await store.save(chatId, messages, (text || files[0]?.name || "Nuevo chat").slice(0, 60));
    markActive();
    if (!els.settingsPanel.hidden) refreshMemory();
  }
});
