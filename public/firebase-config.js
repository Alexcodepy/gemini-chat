// public/firebase-config.js
// Rellena esto cuando registres la web app en Firebase (Configuración → Tus apps → Web).
// Mientras apiKey siga con el placeholder, la app corre en modo local (localStorage + proxy).
export const firebaseConfig = {
  apiKey: "TU_WEB_API_KEY",
  authDomain: "gemini38flash.firebaseapp.com",
  projectId: "gemini38flash",
  storageBucket: "gemini38flash.firebasestorage.app",
  messagingSenderId: "42540542552",
  appId: "TU_APP_ID"
};

export const MODEL_LABEL = "Gemini 3.8 Flash";
export const FUNCTIONS_REGION = "europe-west1";
export const isLocalMode = firebaseConfig.apiKey.startsWith("TU_");
