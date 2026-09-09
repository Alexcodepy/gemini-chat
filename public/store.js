// public/store.js — persistencia de chats. Local: localStorage. Remoto: Firestore.
import { firebaseConfig, FUNCTIONS_REGION, isLocalMode } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/11.3.1";

export async function createStore() {
  return isLocalMode ? localStore() : firebaseStore();
}

// Los bytes de los adjuntos no caben en localStorage: se guardan solo en memoria
// durante la sesión y se persiste únicamente el nombre y el tipo.
const stripFileData = (messages) =>
  messages.map(({ role, text, files }) => ({
    role,
    text,
    ...(files?.length ? { files: files.map(({ name, mimeType }) => ({ name, mimeType })) } : {})
  }));

// MARK: - Local

function localStore() {
  const KEY = "gemini-chat:chats";
  const read = () => JSON.parse(localStorage.getItem(KEY) ?? "[]");
  const write = (chats) => localStorage.setItem(KEY, JSON.stringify(chats));
  let listener = null;
  const emit = () => listener?.(read().map(({ id, title }) => ({ id, title })));

  return {
    local: true,
    user: { email: "local" },
    async signIn() {}, async signOut() {},
    onReady(cb) { cb(true); },
    onChats(cb) { listener = cb; emit(); },
    async load(id) { return read().find((c) => c.id === id)?.messages ?? []; },
    async save(id, messages, title) {
      const chats = read();
      const existing = chats.find((c) => c.id === id);
      if (existing) {
        existing.messages = stripFileData(messages);
      } else {
        id = crypto.randomUUID();
        chats.unshift({ id, title, messages: stripFileData(messages) });
      }
      write(chats);
      emit();
      return id;
    },
    async rename(id, title) {
      const chats = read();
      const chat = chats.find((c) => c.id === id);
      if (!chat) return;
      chat.title = title;
      write(chats);
      emit();
    },
    async remove(id) {
      write(read().filter((c) => c.id !== id));
      emit();
    }
  };
}

// MARK: - Firebase

async function firebaseStore() {
  const [{ initializeApp }, authMod, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`)
  ]);

  const app = initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  const db = fs.getFirestore(app);
  let uid = null;

  const chatDoc = (id) => fs.doc(db, "users", uid, "chats", id);

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
      return (await fs.getDoc(chatDoc(id))).data()?.messages ?? [];
    },
    async save(id, messages, title) {
      const payload = { messages: stripFileData(messages), updatedAt: fs.serverTimestamp() };
      if (id) {
        await fs.updateDoc(chatDoc(id), payload);
        return id;
      }
      const ref = await fs.addDoc(fs.collection(db, "users", uid, "chats"), {
        ...payload, title, createdAt: fs.serverTimestamp()
      });
      return ref.id;
    },
    rename: (id, title) => fs.updateDoc(chatDoc(id), { title }),
    remove: (id) => fs.deleteDoc(chatDoc(id))
  };
}
