// public/store.js — persistencia de chats. Local: localStorage. Remoto: Firestore.
import { firebaseConfig, FUNCTIONS_REGION, isLocalMode } from "./firebase-config.js";
import { streamDirect } from "./gemini.js";

const SDK = "https://www.gstatic.com/firebasejs/11.3.1";

export async function createStore() {
  return isLocalMode ? localStore(await hasProxy()) : firebaseStore();
}

// Sin proxy (GitHub Pages) la llamada sale del navegador con la key del usuario.
async function hasProxy() {
  try {
    return (await fetch("/api/health", { method: "GET" })).ok;
  } catch {
    return false;
  }
}

// MARK: - Local

function localStore(proxy) {
  const KEY = "gemini-chat:chats";
  const read = () => JSON.parse(localStorage.getItem(KEY) ?? "[]");
  const write = (chats) => localStorage.setItem(KEY, JSON.stringify(chats));
  let listener = null;
  const emit = () => listener?.(read().map(({ id, title }) => ({ id, title })));

  return {
    local: true,
    proxy,
    user: { email: "local" },
    async signIn() {}, async signOut() {},
    onReady(cb) { cb(true); },
    onChats(cb) { listener = cb; emit(); },
    async load(id) { return read().find((c) => c.id === id)?.messages ?? []; },
    async save(id, messages, title) {
      const chats = read();
      const existing = chats.find((c) => c.id === id);
      if (existing) {
        existing.messages = messages;
      } else {
        id = crypto.randomUUID();
        chats.unshift({ id, title, messages });
      }
      write(chats);
      emit();
      return id;
    },
    async *send({ history, message }) {
      if (!proxy) {
        yield* streamDirect({ history, message });
        return;
      }
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ history, message })
      });
      if (!res.ok) throw new Error(await res.text());
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        yield decoder.decode(value, { stream: true });
      }
    }
  };
}

// MARK: - Firebase

async function firebaseStore() {
  const [{ initializeApp }, authMod, fs, fn] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
    import(`${SDK}/firebase-functions.js`)
  ]);

  const app = initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  const db = fs.getFirestore(app);
  const chatFn = fn.httpsCallable(fn.getFunctions(app, FUNCTIONS_REGION), "chat");
  let uid = null;

  return {
    local: false,
    get user() { return auth.currentUser; },
    signIn: () => authMod.signInWithPopup(auth, new authMod.GoogleAuthProvider()),
    signOut: () => authMod.signOut(auth),
    onReady(cb) {
      authMod.onAuthStateChanged(auth, (user) => { uid = user?.uid ?? null; cb(!!user); });
    },
    onChats(cb) {
      if (!uid) return;
      fs.onSnapshot(
        fs.query(fs.collection(db, "users", uid, "chats"), fs.orderBy("updatedAt", "desc")),
        (snap) => cb(snap.docs.map((d) => ({ id: d.id, title: d.data().title })))
      );
    },
    async load(id) {
      const snap = await fs.getDoc(fs.doc(db, "users", uid, "chats", id));
      return snap.data()?.messages ?? [];
    },
    async save(id, messages, title) {
      const payload = { messages, updatedAt: fs.serverTimestamp() };
      if (id) {
        await fs.updateDoc(fs.doc(db, "users", uid, "chats", id), payload);
        return id;
      }
      const ref = await fs.addDoc(fs.collection(db, "users", uid, "chats"), {
        ...payload, title, createdAt: fs.serverTimestamp()
      });
      return ref.id;
    },
    async *send(payload) {
      const { stream, data } = await chatFn.stream(payload);
      for await (const chunk of stream) yield chunk;
      await data;
    }
  };
}
