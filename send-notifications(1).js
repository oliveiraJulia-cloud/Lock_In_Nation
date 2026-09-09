// Motor de notificação real (Etapa 5).
// Roda a cada ~5 min via GitHub Actions. Lê a coleção "goals" no Firestore,
// calcula o que deveria disparar agora (hora de Brasília) e manda push via FCM.
// Evita duplicar notificação usando a coleção "notifyLog" como controle de estado.
// Também dispara, uma vez por dia às 20:00 (Brasília), o aviso de véspera do
// ciclo: usa a mesma previsão (média dos últimos ciclos) mostrada na aba
// Progresso e avisa quando a data prevista é amanhã.

import admin from "firebase-admin";

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function getBrazilNow() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    dateISO: `${parts.year}-${parts.month}-${parts.day}`,
    dayOfMonth: Number(parts.day),
    weekday: WEEKDAY_INDEX[parts.weekday],
    minutes: Number(parts.hour) * 60 + Number(parts.minute === "24" ? "00" : parts.minute),
  };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function toHHMM(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, "0");
  const m = (mins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}
function randomTimeInWindow(startHHMM, endHHMM) {
  const start = toMinutes(startHHMM);
  const end = toMinutes(endHHMM);
  const rand = start + Math.floor(Math.random() * (end - start));
  return toHHMM(rand - (rand % 5));
}

function addDaysISO(dateISO, n) {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetweenISO(a, b) {
  return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
}

// Mesmo cálculo de "próximo previsto" usado na aba Progresso do app (bodySectionHTML):
// média dos intervalos entre os últimos registros de ciclo, somada ao último início.
async function computeCyclePrediction() {
  const snap = await db.collection("cycleEntries").orderBy("dateISO").get();
  const entries = snap.docs.map((d) => d.data());
  if (entries.length < 2) return null;

  const diffs = [];
  for (let i = 1; i < entries.length; i++) diffs.push(daysBetweenISO(entries[i - 1].dateISO, entries[i].dateISO));
  const avgCycle = Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length);
  const predicted = addDaysISO(entries[entries.length - 1].dateISO, avgCycle);
  return { avgCycle, predicted };
}

function computeFireTimes(goal, today, anyTimeSlot) {
  switch (goal.type) {
    case "checklist":
      return (goal.weekdays || []).includes(today.weekday) ? [goal.anyTime ? anyTimeSlot : goal.time] : [];
    case "daily":
      return [goal.anyTime ? anyTimeSlot : goal.time];
    case "intervalo": {
      const times = [];
      for (let t = toMinutes(goal.intervalStart); t <= toMinutes(goal.intervalEnd); t += goal.everyHours * 60) {
        times.push(toHHMM(t));
      }
      return times;
    }
    case "avulso":
      return goal.date === today.dateISO ? [goal.anyTime ? anyTimeSlot : goal.time] : [];
    case "mensal":
      return goal.dayOfMonth === today.dayOfMonth ? [goal.anyTime ? anyTimeSlot : goal.time] : [];
    default:
      return [];
  }
}

const CYCLE_ALERT_TIME = "20:00"; // horário do aviso de véspera, Brasília

async function checkCycleEve(today, currentBucket, fcmToken) {
  const prediction = await computeCyclePrediction();
  if (!prediction) return; // precisa de pelo menos 2 registros de ciclo pra existir previsão

  const vesperaDate = addDaysISO(prediction.predicted, -1);
  if (today.dateISO !== vesperaDate) return;

  const alertBucket = Math.floor(toMinutes(CYCLE_ALERT_TIME) / 5);
  if (currentBucket !== alertBucket) return;

  const logRef = db.collection("notifyLog").doc("cycle-eve");
  const logSnap = await logRef.get();
  const log = logSnap.exists ? logSnap.data() : {};
  if (log.date === today.dateISO) return; // já disparado hoje

  try {
    await admin.messaging().send({
      token: fcmToken,
      data: {
        title: "Metas Pessoais",
        body: `Seu ciclo é previsto pra amanhã (${prediction.predicted.split("-").reverse().join("/")}).`,
      },
    });
    console.log(`Aviso de véspera do ciclo disparado (previsto: ${prediction.predicted}).`);
    await logRef.set({ date: today.dateISO }, { merge: false });
  } catch (err) {
    console.error("Falha ao notificar véspera do ciclo:", err.message);
  }
}

async function main() {
  const today = getBrazilNow();
  const currentBucket = Math.floor(today.minutes / 5);

  const deviceSnap = await db.collection("device").doc("current").get();
  const fcmToken = deviceSnap.exists ? deviceSnap.data().fcmToken : null;
  if (!fcmToken) {
    console.log("Nenhum token de dispositivo salvo ainda. Nada a fazer.");
    return;
  }

  await checkCycleEve(today, currentBucket, fcmToken);

  const goalsSnap = await db.collection("goals").get();
  if (goalsSnap.empty) {
    console.log("Nenhuma meta cadastrada ainda em 'goals'. Nada mais a fazer.");
    return;
  }

  const events = [];
  for (const doc of goalsSnap.docs) {
    const goal = { id: doc.id, ...doc.data() };
    if (goal.paused) continue;
    const logRef = db.collection("notifyLog").doc(goal.id);
    const logSnap = await logRef.get();
    let log = logSnap.exists ? logSnap.data() : {};

    if (log.date !== today.dateISO) {
      log = { date: today.dateISO, firedTimes: [] };
    }

   let anyTimeSlot;
    if (goal.anyTime) {
      anyTimeSlot = log.anyTimeSlot;
      if (!anyTimeSlot || log.date !== today.dateISO) {
        const window = goal.anyTimeWindow || ["09:00", "21:00"];
        anyTimeSlot = randomTimeInWindow(window[0], window[1]);
      }
      log.anyTimeSlot = anyTimeSlot;
    }

    const times = computeFireTimes(goal, today, anyTimeSlot);
    for (const time of times) events.push({ goal, time, minutes: toMinutes(time), originalMinutes: toMinutes(time), log, logRef });
  }

  events.sort((a, b) => a.minutes - b.minutes || a.goal.id.localeCompare(b.goal.id));
  const used = new Set();
  for (const e of events) {
    while (used.has(e.minutes)) e.minutes += 2;
    used.add(e.minutes);
    e.time = toHHMM(e.minutes);
  }

  const dueNow = events.filter((e) => Math.floor(e.minutes / 5) === currentBucket && !e.log.firedTimes.includes(e.time));

  if (dueNow.length === 0) {
    console.log(`Tick ${toHHMM(today.minutes)} (Brasília) — nada vencendo agora.`);
    return;
  }

  for (const e of dueNow) {
    const body = e.goal.type === "intervalo" ? `Check-in: ${e.goal.title}` : e.goal.title;

    try {
      await admin.messaging().send({
        token: fcmToken,
        data: { title: "Metas Pessoais", body },
      });
      console.log(`Disparado: "${e.goal.title}" (${e.time})`);

      e.log.firedTimes.push(e.time);
      await e.logRef.set(e.log, { merge: false });
    } catch (err) {
      console.error(`Falha ao notificar "${e.goal.title}":`, err.message);
    }
  }
}

main().catch((err) => {
  console.error("Erro no motor de notificação:", err);
  process.exit(1);
});
