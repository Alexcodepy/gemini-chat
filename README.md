# gemini-chat

Interfaz de chat minimalista sobre la API de Gemini. Streaming, historial y tema claro/oscuro.

## Local

```bash
cp .env.example .env   # añade tu GEMINI_API_KEY
npm run dev            # http://localhost:5173
```

Un proxy Node (`server.js`) sirve el front y habla con Gemini: la API key nunca llega al navegador.
Los chats se guardan en `localStorage`.

## Firebase (opcional)

Rellena `public/firebase-config.js` con los datos de tu web app y la app cambia sola a
Auth con Google + Firestore + la Cloud Function de `functions/`. Requiere plan Blaze.

```bash
firebase functions:secrets:set GEMINI_API_KEY
firebase deploy --only functions,hosting,firestore:rules
```

## Funciones

- Selector de modelo (se lee la lista real de la API).
- Renombrar y eliminar chats desde el sidebar.
- Ajustes muestra la memoria del chat: tokens usados sobre el límite del modelo.
- Dictado por voz: el audio se graba y lo transcribe el propio modelo.
- Adjuntos: imágenes, PDF, audio, vídeo y texto (máx. 15 MB por archivo).

## Notas

- `GEMINI_THINKING_BUDGET=0` desactiva el razonamiento del modelo. Con él activo el primer token
  tarda ~5s más y aumentan los 503. Ponlo a `-1` para razonamiento dinámico.
- El servidor reintenta con backoff exponencial ante 429/500/502/503/504.
- Los bytes de los adjuntos viven solo en memoria durante la sesión; al recargar se
  conserva el nombre del archivo en el historial, no su contenido.
