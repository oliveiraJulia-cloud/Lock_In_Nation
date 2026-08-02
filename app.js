import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { getFirestore, doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { getMessaging, getToken } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging.js";

// Config pública do Firebase — não é segredo, é feita pra rodar no navegador.
// A segurança de verdade vem das regras do Firestore, não do sigilo disso aqui.
const firebaseConfig = {
  apiKey: "AIzaSyAN28k6HLIRQc7VcYci9Yr0yAeIbyxDWgM",
  authDomain: "lockinnation.firebaseapp.com",
  projectId: "lockinnation",
  storageBucket: "lockinnation.firebasestorage.app",
  messagingSenderId: "487272606594",
  appId: "1:487272606594:web:567795358c1bad4cacfd9b",
};

const VAPID_KEY = "BGDJ-JiMaosfdCRncZuMI2cuS0UMvJ7VkRjNPz2vcrESFaOYXBy957HUSjTggwt2gXdgpiEVosl5s7f9VMWyM9c";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const dot = (id, state) => (document.getElementById(id).className = `dot ${state}`);
const log = (msg) => (document.getElementById("log").textContent = msg);

let swRegistration = null;
let currentUid = null;

async function boot() {
  // 1. Service worker
  try {
    swRegistration = await navigator.serviceWorker.register("sw.js");
    dot("dot-sw", "ok");
  } catch (e) {
    dot("dot-sw", "err");
    log("Erro no service worker: " + e.message);
    return;
  }

  // 2. Login anônimo
  onAuthStateChanged(auth, (user) => {
    if (user) {
      currentUid = user.uid;
      dot("dot-auth", "ok");
      log("UID anônimo: " + user.uid + "\n\n⚠️ copie esse UID — ele vai ser usado pra travar as regras do Firestore só pra você.");
    }
  });
  try {
    await signInAnonymously(auth);
  } catch (e) {
    dot("dot-auth", "err");
    log("Erro no login anônimo: " + e.message);
  }
}

async function activateNotifications() {
  document.getElementById("btn-activate").disabled = true;

  // 3. Permissão do navegador
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    dot("dot-perm", "err");
    log("Permissão negada. Pra tentar de novo, libere notificações nas configurações do navegador/site.");
    document.getElementById("btn-activate").disabled = false;
    return;
  }
  dot("dot-perm", "ok");

  // 4. Token do FCM + salvar no Firestore
  try {
    const messaging = getMessaging(app);
    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: swRegistration,
    });

    if (!token) throw new Error("Token vazio — verifique a chave VAPID.");

    await setDoc(doc(db, "device", "current"), {
      fcmToken: token,
      ownerUid: currentUid,
      updatedAt: serverTimestamp(),
    });

    dot("dot-token", "ok");
    log("Tudo certo! Token salvo. Agora dá pra testar o envio via GitHub Actions.");
  } catch (e) {
    dot("dot-token", "err");
    log("Erro ao gerar/salvar o token: " + e.message);
  }
  document.getElementById("btn-activate").disabled = false;
}

document.getElementById("btn-activate").addEventListener("click", activateNotifications);
boot();
