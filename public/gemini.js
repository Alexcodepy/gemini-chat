// public/gemini.js — llamada directa a Gemini desde el navegador, con la key del propio usuario.
// Solo se usa cuando no hay proxy (GitHub Pages). En local el proxy guarda la key en el servidor.
const MODEL = "gemini-3.8-flash";
const SYSTEM_INSTRUCTION = "Eres un asistente conciso y directo. Responde en el idioma del usuario.";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;

const KEY_STORAGE = "gemini-chat:apiKey";

export const getApiKey = () => localStorage.getItem(KEY_STORAGE) ?? "";
export const setApiKey = (key) => localStorage.setItem(KEY_STORAGE, key.trim());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function* streamDirect({ history, message }) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Añade tu API key de Google AI Studio en Ajustes (⚙).");

  const contents = [...history, { role: "user", text: message }]
    .filter((m) => typeof m.text === "string" && m.text.length > 0)
    .slice(-40)
    .map((m) => ({ role: m.role === "model" ? "model" : "user", parts: [{ text: m.text }] }));

  const body = JSON.stringify({
    contents,
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } }
  });

  let res = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`,
      { method: "POST", headers: { "content-type": "application/json" }, body }
    );
    if (res.ok) break;
    if (!RETRY_STATUS.has(res.status) || attempt === MAX_RETRIES) {
      const detail = await res.text();
      throw new Error(
        RETRY_STATUS.has(res.status)
          ? "El modelo está saturado ahora mismo. Vuelve a intentarlo en unos segundos."
          : (JSON.parse(detail)?.error?.message ?? detail)
      );
    }
    await sleep(700 * 2 ** attempt + Math.random() * 400);
  }

  const reader = res.body.getReader();
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
        const text = parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
        if (text) yield text;
      } catch { /* fragmento SSE incompleto */ }
    }
  }
}
