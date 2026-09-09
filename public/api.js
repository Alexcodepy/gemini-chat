// public/api.js — capa de red. Con proxy local la key vive en el servidor;
// sin él (GitHub Pages) la llamada sale del navegador con la key del usuario.

const KEY_STORAGE = "gemini-chat:apiKey";
const MODEL_STORAGE = "gemini-chat:model";
const DEFAULT_MODEL = "gemini-3.8-flash";
const SYSTEM_INSTRUCTION = "Eres un asistente conciso y directo. Responde en el idioma del usuario.";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;
const MAX_HISTORY = 40;
const BASE = "https://generativelanguage.googleapis.com/v1beta";

let hasProxy = false;

export const getApiKey = () => localStorage.getItem(KEY_STORAGE) ?? "";
export const setApiKey = (key) => localStorage.setItem(KEY_STORAGE, key.trim());
export const getModel = () => localStorage.getItem(MODEL_STORAGE) ?? DEFAULT_MODEL;
export const setModel = (m) => localStorage.setItem(MODEL_STORAGE, m);
export const usesProxy = () => hasProxy;

export async function initApi() {
  try {
    hasProxy = (await fetch("/api/health")).ok;
  } catch {
    hasProxy = false;
  }
  return hasProxy;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requireKey() {
  const key = getApiKey();
  if (!key) throw new Error("Añade tu API key de Google AI Studio en Ajustes (⚙).");
  return key;
}

// MARK: - Construcción de contenidos

function partsFor(msg) {
  const parts = (msg.files ?? [])
    .filter((f) => f.data)
    .map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.data } }));
  if (msg.text) parts.push({ text: msg.text });
  return parts.length ? parts : [{ text: " " }];
}

export function buildContents(history, message, files) {
  return [...history, { role: "user", text: message, files }]
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role === "model" ? "model" : "user", parts: partsFor(m) }))
    .filter((c) => c.parts.length);
}

// MARK: - Errores

async function describeError(res) {
  const body = await res.text();
  if (res.status === 429) {
    return "Has superado la cuota de la API. Espera un momento o revisa tu plan en AI Studio.";
  }
  if (RETRY_STATUS.has(res.status)) {
    return "El modelo está saturado ahora mismo. Vuelve a intentarlo en unos segundos.";
  }
  try {
    return JSON.parse(body)?.error?.message ?? body;
  } catch {
    return body;
  }
}

async function callGoogle(path, init) {
  const key = requireKey();
  let res = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    res = await fetch(`${BASE}/${path}${path.includes("?") ? "&" : "?"}key=${key}`, init);
    if (res.ok) return res;
    if (!RETRY_STATUS.has(res.status) || attempt === MAX_RETRIES) {
      throw new Error(await describeError(res));
    }
    await sleep(700 * 2 ** attempt + Math.random() * 400);
  }
}

async function callProxy(path, payload) {
  const res = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
  return res;
}

// MARK: - Modelos

export async function listModels() {
  const res = hasProxy
    ? await fetch("/api/models")
    : await callGoogle("models?pageSize=200", {});
  if (!res.ok) throw new Error(await describeError(res));
  const { models = [] } = await res.json();

  return models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .filter((m) => !/tts|image|embedding|native-audio/.test(m.name))
    .map((m) => ({
      id: m.name.replace("models/", ""),
      label: m.displayName,
      inputTokenLimit: m.inputTokenLimit
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// MARK: - Tokens

export async function countTokens(contents) {
  const model = getModel();
  const res = hasProxy
    ? await callProxy("tokens", { model, contents })
    : await callGoogle(`models/${model}:countTokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents })
      });
  return (await res.json()).totalTokens ?? 0;
}

// MARK: - Transcripción

export async function transcribe(base64, mimeType) {
  const body = {
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType, data: base64 } },
        { text: "Transcribe este audio literalmente. Devuelve solo la transcripción, sin comillas ni comentarios." }
      ]
    }],
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } }
  };

  const res = hasProxy
    ? await callProxy("transcribe", { model: getModel(), ...body })
    : await callGoogle(`models/${getModel()}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });

  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

// MARK: - Chat

export async function* stream({ history, message, files }) {
  const model = getModel();
  const contents = buildContents(history, message, files);
  const payload = {
    contents,
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } }
  };

  const res = hasProxy
    ? await callProxy("chat", { model, ...payload })
    : await callGoogle(`models/${model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

  // El proxy ya devuelve texto plano; en directo hay que desenvolver el SSE.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });

    if (hasProxy) {
      yield chunk;
      continue;
    }

    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const parts = JSON.parse(raw).candidates?.[0]?.content?.parts ?? [];
        const text = parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
        if (text) yield text;
      } catch { /* fragmento SSE incompleto */ }
    }
  }
}
