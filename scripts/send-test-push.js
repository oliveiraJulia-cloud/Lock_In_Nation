// Script de teste da Etapa 4: confirma que o cano completo funciona —
// GitHub Actions lê o Firestore, chama a API do FCM, e o push chega no celular.
// (A lógica de verdade, que decide O QUE notificar, entra na Etapa 6.)

import admin from "firebase-admin";

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function main() {
  const snap = await db.collection("device").doc("current").get();

  if (!snap.exists) {
    console.error("Nenhum token encontrado em device/current. Abra o app e clique em 'Ativar notificações' primeiro.");
    process.exit(1);
  }

  const { fcmToken } = snap.data();
  if (!fcmToken) {
    console.error("Documento existe mas não tem fcmToken.");
    process.exit(1);
  }

  const response = await admin.messaging().send({
    token: fcmToken,
    notification: {
      title: "🎉 Funcionou!",
      body: "Esse push veio do GitHub Actions até o seu celular.",
    },
  });

  console.log("Notificação enviada com sucesso:", response);
}

main().catch((err) => {
  console.error("Falha ao enviar notificação:", err);
  process.exit(1);
});
