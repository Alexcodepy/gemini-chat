// functions/index.js
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { GoogleGenAI } = require("@google/genai");

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

const MODEL = "gemini-3.8-flash";
const SYSTEM_INSTRUCTION = "Eres un asistente conciso y directo. Responde en el idioma del usuario.";
const MAX_HISTORY = 40;
// El razonamiento del modelo añade ~5s antes del primer token. 0 lo desactiva, -1 lo deja dinámico.
const THINKING_BUDGET = 0;

exports.chat = onCall(
  { region: "europe-west1", secrets: [GEMINI_API_KEY], cors: true, timeoutSeconds: 300 },
  async (request, response) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Login required");

    const { history = [], message } = request.data ?? {};
    if (typeof message !== "string" || !message.trim()) {
      throw new HttpsError("invalid-argument", "message required");
    }

    const contents = [...history, { role: "user", text: message }]
      .slice(-MAX_HISTORY)
      .filter((m) => typeof m.text === "string" && m.text.length > 0)
      .map((m) => ({
        role: m.role === "model" ? "model" : "user",
        parts: [{ text: m.text }]
      }));

    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY.value() });

    let full = "";
    try {
      const stream = await ai.models.generateContentStream({
        model: MODEL,
        contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          thinkingConfig: { thinkingBudget: THINKING_BUDGET }
        }
      });

      for await (const chunk of stream) {
        const text = chunk.text;
        if (!text) continue;
        full += text;
        // Si el cliente no soporta streaming acumulamos y devolvemos al final.
        if (response.acceptsStreaming) response.sendChunk(text);
      }
    } catch (err) {
      throw new HttpsError("internal", err.message ?? "Gemini error");
    }

    return full;
  }
);
