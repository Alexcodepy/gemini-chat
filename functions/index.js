// functions/index.js — mismo contrato que server.js, para Firebase Hosting.
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

const DEFAULT_MODEL = "gemini-3.8-flash";
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gemini devuelve 503 cuando está saturado; reintentamos con backoff exponencial.
async function callGoogle(path, init) {
  const key = GEMINI_API_KEY.value();
  let last = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${BASE}/${path}${path.includes("?") ? "&" : "?"}key=${key}`, init);
    if (res.ok) return res;

    last = { status: res.status, body: await res.text() };
    if (!RETRY_STATUS.has(res.status) || attempt === MAX_RETRIES) break;
    await sleep(700 * 2 ** attempt + Math.random() * 400);
  }

  let message;
  if (last.status === 429) {
    message = "Has superado la cuota de la API. Espera un momento o revisa tu plan en AI Studio.";
  } else if (RETRY_STATUS.has(last.status)) {
    message = "El modelo está saturado ahora mismo. Vuelve a intentarlo en unos segundos.";
  } else {
    try { message = JSON.parse(last.body)?.error?.message ?? last.body; }
    catch { message = last.body; }
  }
  throw Object.assign(new Error(message), { status: last.status });
}

const jsonInit = (payload) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload)
});

async function streamChat(body, res) {
  const { model = DEFAULT_MODEL, ...rest } = body;
  const upstream = await callGoogle(`models/${model}:streamGenerateContent?alt=sse`, jsonInit(rest));

  res.set("content-type", "text/plain; charset=utf-8");
  res.set("cache-control", "no-store");

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parts = JSON.parse(payload).candidates?.[0]?.content?.parts ?? [];
        // Los parts marcados `thought` son razonamiento interno, no respuesta.
        const text = parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
        if (text) res.write(text);
      } catch { /* fragmento SSE incompleto */ }
    }
  }
  res.end();
}

exports.api = onRequest(
  { region: "europe-west1", secrets: [GEMINI_API_KEY], memory: "512MiB", timeoutSeconds: 300 },
  async (req, res) => {
    const route = req.path.replace(/^\/api/, "");
    try {
      if (route === "/health") {
        res.status(204).end();
      } else if (route === "/models") {
        res.type("json").send(await (await callGoogle("models?pageSize=200", {})).text());
      } else if (route === "/tokens") {
        const { model = DEFAULT_MODEL, contents } = req.body ?? {};
        res.type("json").send(await (await callGoogle(`models/${model}:countTokens`, jsonInit({ contents }))).text());
      } else if (route === "/transcribe") {
        const { model = DEFAULT_MODEL, ...body } = req.body ?? {};
        res.type("json").send(await (await callGoogle(`models/${model}:generateContent`, jsonInit(body))).text());
      } else if (route === "/chat") {
        await streamChat(req.body ?? {}, res);
      } else {
        res.status(404).send("Not found");
      }
    } catch (err) {
      if (!res.headersSent) res.status(err.status ?? 500);
      res.end(err.message);
    }
  }
);
