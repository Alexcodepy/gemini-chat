// public/app.js
import { MODEL_LABEL } from "./firebase-config.js";
import { createStore } from "./store.js";
import { getApiKey, setApiKey } from "./gemini.js";

const $ = (id) => document.getElementById(id);
const els = {
  gate: $("authGate"), signIn: $("signIn"), signOut: $("signOut"), userEmail: $("userEmail"),
  sidebar: $("sidebar"), toggleSidebar: $("toggleSidebar"), newChat: $("newChat"), chatList: $("chatList"),
  messages: $("messages"), composer: $("composer"), input: $("input"), send: $("send"), modelName: $("modelName"),
  toggleSettings: $("toggleSettings"), settingsPanel: $("settingsPanel"), themeOptions: $("themeOptions"),
  apiKeySection: $("apiKeySection"), apiKey: $("apiKey")
};

const store = await createStore();
let chatId = null;
let messages = [];
let busy = false;

els.modelName.textContent = MODEL_LABEL + (store.local ? " · local" : "");
els.signIn.onclick = () => store.signIn();
els.signOut.onclick = () => store.signOut();
els.newChat.onclick = newChat;
els.toggleSidebar.onclick = () => els.sidebar.classList.toggle("collapsed");

store.onReady((authed) => {
  els.gate.classList.toggle("hidden", authed);
  els.userEmail.textContent = store.user?.email ?? "";
  if (!authed) return;
  store.onChats(renderChatList);
  newChat();
});

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

// El campo de key solo aparece si no hay proxy que la guarde por nosotros.
if (store.local && !store.proxy) {
  els.apiKeySection.hidden = false;
  els.apiKey.value = getApiKey();
  els.apiKey.oninput = () => setApiKey(els.apiKey.value);
  if (!getApiKey()) els.settingsPanel.hidden = false;
}

els.themeOptions.onclick = (e) => {
  const theme = e.target.closest("button")?.dataset.theme;
  if (theme) applyTheme(theme);
};

els.toggleSettings.onclick = (e) => {
  e.stopPropagation();
  els.settingsPanel.hidden = !els.settingsPanel.hidden;
};

document.addEventListener("click", (e) => {
  if (!els.settingsPanel.hidden && !els.settingsPanel.contains(e.target)) {
    els.settingsPanel.hidden = true;
  }
});

// MARK: - Chats

function newChat() {
  chatId = null;
  messages = [];
  renderMessages();
  markActive();
  els.input.focus();
}

function renderChatList(chats) {
  els.chatList.replaceChildren(...chats.map(({ id, title }) => {
    const b = document.createElement("button");
    b.className = "chat-item";
    b.dataset.id = id;
    b.textContent = title || "Nuevo chat";
    b.onclick = () => openChat(id);
    return b;
  }));
  markActive();
}

function markActive() {
  for (const el of els.chatList.children) el.classList.toggle("active", el.dataset.id === chatId);
}

async function openChat(id) {
  chatId = id;
  messages = await store.load(id);
  renderMessages();
  markActive();
  if (window.innerWidth <= 768) els.sidebar.classList.add("collapsed");
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
  if (msg.role === "user") b.textContent = msg.text;
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
  if (!text || busy) return;

  els.input.value = "";
  els.input.style.height = "auto";
  busy = true;
  els.send.disabled = true;

  const history = messages.map(({ role, text }) => ({ role, text }));
  messages.push({ role: "user", text });
  els.messages.append(bubbleFor(messages.at(-1)));

  const reply = { role: "model", text: "" };
  messages.push(reply);
  const node = bubbleFor(reply);
  const bubble = node.querySelector(".bubble");
  bubble.classList.add("cursor");
  els.messages.append(node);
  scrollToBottom();

  try {
    for await (const chunk of store.send({ history, message: text })) {
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
    chatId = await store.save(chatId, messages, text.slice(0, 60));
    markActive();
  }
});
