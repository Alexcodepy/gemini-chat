// server.js — proxy local de desarrollo. La API key nunca llega al navegador.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = 5173;
const API_KEY = process.env.GEMINI_API_KEY;
const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;
const MAX_BODY = 32 * 1024 * 1024;

if (!API_KEY) {
  console.error("Falta GEMINI_API_KEY. Usa: GEMINI_API_KEY=... node server.js");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Adjuntos demasiado grandes"), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

// Gemini devuelve 503 cuando está saturado; reintentamos con backoff exponencial.
async function callGoogle(path, init) {
  let last = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${BASE}/${path}${path.includes("?") ? "&" : "?"}key=${API_KEY}`, init);
    if (res.ok) return res;

    last = { status: res.status, body: await res.text() };
    if (!RETRY_STATUS.has(res.status) || attempt === MAX_RETRIES) break;

    const delay = 700 * 2 ** attempt + Math.random() * 400;
    console.warn(`${res.status} de Gemini, reintento ${attempt + 1}/${MAX_RETRIES} en ${Math.round(delay)}ms`);
    await sleep(delay);
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

// MARK: - Endpoints

async function handleModels(res) {
  const upstream = await callGoogle("models?pageSize=200", {});
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(await upstream.text());
}

async function handleTokens(req, res) {
  const { model = DEFAULT_MODEL, contents } = await readBody(req);
  const upstream = await callGoogle(`models/${model}:countTokens`, jsonInit({ contents }));
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(await upstream.text());
}

async function handleTranscribe(req, res) {
  const { model = DEFAULT_MODEL, ...body } = await readBody(req);
  const upstream = await callGoogle(`models/${model}:generateContent`, jsonInit(body));
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(await upstream.text());
}

async function handleChat(req, res) {
  const { model = DEFAULT_MODEL, ...body } = await readBody(req);
  if (!body.contents?.length) throw Object.assign(new Error("contents required"), { status: 400 });

  const upstream = await callGoogle(`models/${model}:streamGenerateContent?alt=sse`, jsonInit(body));

  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no"
  });

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
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

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const path = join(process.cwd(), "public", normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": MIME[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store"
    }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

const ROUTES = {
  "/api/tokens": handleTokens,
  "/api/transcribe": handleTranscribe,
  "/api/chat": handleChat
};

createServer(async (req, res) => {
  try {
    if (req.url === "/api/health") res.writeHead(204).end();
    else if (req.url === "/api/models") await handleModels(res);
    else if (req.method === "POST" && ROUTES[req.url]) await ROUTES[req.url](req, res);
    else await serveStatic(req, res);
  } catch (err) {
    console.error(err.message);
    if (!res.headersSent) {
      res.writeHead(err.status ?? 500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(err.message);
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}  ·  ${DEFAULT_MODEL}`));
