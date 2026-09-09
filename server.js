// server.js — proxy local de desarrollo. La API key nunca llega al navegador.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = 5173;
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
const API_KEY = process.env.GEMINI_API_KEY;
const SYSTEM_INSTRUCTION = "Eres un asistente conciso y directo. Responde en el idioma del usuario.";
// El razonamiento del modelo añade ~5s antes del primer token. 0 lo desactiva, -1 lo deja dinámico.
const THINKING_BUDGET = Number(process.env.GEMINI_THINKING_BUDGET ?? 0);

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

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// El modelo devuelve 503 cuando está saturado; reintentamos con backoff exponencial.
async function callGemini(contents) {
  let last = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          generationConfig: { thinkingConfig: { thinkingBudget: THINKING_BUDGET } }
        })
      }
    );
    if (res.ok) return res;

    last = { status: res.status, body: await res.text() };
    if (!RETRY_STATUS.has(res.status) || attempt === MAX_RETRIES) break;

    const delay = 700 * 2 ** attempt + Math.random() * 400;
    console.warn(`${res.status} de Gemini, reintento ${attempt + 1}/${MAX_RETRIES} en ${Math.round(delay)}ms`);
    await sleep(delay);
  }

  const message = RETRY_STATUS.has(last.status)
    ? "El modelo está saturado ahora mismo. Vuelve a intentarlo en unos segundos."
    : (JSON.parse(last.body)?.error?.message ?? last.body);
  throw Object.assign(new Error(message), { status: last.status });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

async function handleChat(req, res) {
  const { history = [], message } = await readBody(req);
  if (typeof message !== "string" || !message.trim()) {
    res.writeHead(400).end("message required");
    return;
  }

  const contents = [...history, { role: "user", text: message }]
    .filter((m) => typeof m.text === "string" && m.text.length > 0)
    .slice(-40)
    .map((m) => ({ role: m.role === "model" ? "model" : "user", parts: [{ text: m.text }] }));

  let upstream;
  try {
    upstream = await callGemini(contents);
  } catch (err) {
    res.writeHead(err.status ?? 502, { "content-type": "text/plain; charset=utf-8" }).end(err.message);
    return;
  }

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

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/chat") await handleChat(req, res);
    else await serveStatic(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(err.message);
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}  ·  ${MODEL}`));
