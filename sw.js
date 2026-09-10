// Service worker do PWA.
// Duas responsabilidades: (1) permitir a instalação do app, (2) receber e exibir
// notificações push mandadas pelo FCM mesmo com o app fechado.

importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");

// Mesma config pública do app (não é segredo, é feita pra rodar no navegador).
firebase.initializeApp({
  apiKey: "AIzaSyAN28k6HLIRQc7VcYci9Yr0yAeIbyxDWgM",
  authDomain: "lockinnation.firebaseapp.com",
  projectId: "lockinnation",
  storageBucket: "lockinnation.firebasestorage.app",
  messagingSenderId: "487272606594",
  appId: "1:487272606594:web:567795358c1bad4cacfd9b",
});

const messaging = firebase.messaging();

// Dispara quando chega um push e o app NÃO está em primeiro plano.
// As mensagens agora são "data-only" (sem campo "notification"), de propósito:
// isso desliga a exibição automática do navegador, que não usa o ícone do app
// e era o que causava a notificação duplicada. Aqui é o único lugar que exibe.
messaging.onBackgroundMessage((payload) => {
  const title = payload.data?.title || "Metas Pessoais";
  const options = {
    body: payload.data?.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
  };
  self.registration.showNotification(title, options);
});

// Necessário existir pra alguns critérios de "instalável" do Chrome.
self.addEventListener("fetch", () => {});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Clicar na notificação leva direto pro app: se já tiver uma aba aberta, foca nela;
// senão, abre uma nova apontando pra raiz do app (self.registration.scope).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = self.registration.scope;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.startsWith(targetUrl));
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});
