import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, collection, query, where, orderBy, onSnapshot,
  addDoc, deleteDoc, doc, setDoc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { getMessaging, getToken } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging.js";

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

const CATEGORY_COLOR = { academia: "var(--accentLight)", saude: "var(--lime)", domestico: "var(--gold)", outros: "var(--muted)" };
const TYPE_META = {
  checklist: { label: "Lembrete", color: "var(--accentLight)" },
  daily: { label: "Diária", color: "var(--amber)" },
  intervalo: { label: "Intervalo", color: "var(--lime)" },
  avulso: { label: "Avulso", color: "var(--pink)" },
  mensal: { label: "Mensal", color: "var(--green)" },
};
const WEEKDAY_LABELS = ["D", "S", "T", "Q", "Q", "S", "S"]; // índice 0 = Domingo, igual ao backend

let currentUid = null;
let swRegistration = null;
let goals = [];
let completions = {}; // hoje: goalId -> { done, count }
let allCompletions = []; // histórico completo, usado em Hoje e Progresso
let weightEntries = [];
let measurementEntries = [];
let cycleEntries = [];
let bodyExpanded = false;
let activeTab = "hoje";

const tabContent = document.getElementById("tab-content");

// ---------- utilidades de data (hora local do aparelho) ----------

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayWeekday() { return new Date().getDay(); } // 0 = Domingo
function todayDayOfMonth() { return new Date().getDate(); }

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function computeIntervaloTotal(g) {
  const start = toMinutes(g.intervalStart), end = toMinutes(g.intervalEnd);
  if (end <= start || !g.everyHours) return 1;
  return Math.floor((end - start) / (g.everyHours * 60)) + 1;
}

function isActiveToday(g) {
  if (g.type === "checklist") return (g.weekdays || []).includes(todayWeekday());
  if (g.type === "daily") return true;
  if (g.type === "intervalo") return true;
  if (g.type === "avulso") return g.date === todayISO();
  if (g.type === "mensal") return g.dayOfMonth === todayDayOfMonth();
  return false;
}

// ---------- boot ----------

async function boot() {
  try {
    swRegistration = await navigator.serviceWorker.register("sw.js");
  } catch (e) {
    console.error("Erro no service worker:", e);
  }

  onAuthStateChanged(auth, (user) => {
    if (!user) return;
    currentUid = user.uid;
    listenGoals();
    listenCompletions();
    listenBodyData();
    maybeShowNotifBanner();
  });

  try {
    await signInAnonymously(auth);
  } catch (e) {
    console.error("Erro no login anônimo:", e);
  }

  document.querySelectorAll("nav.tabbar button").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });
  setTab(activeTab);

  document.getElementById("btn-activate-notif").addEventListener("click", activateNotifications);
}

function maybeShowNotifBanner() {
  const banner = document.getElementById("notif-banner");
  if (Notification.permission !== "granted") banner.style.display = "flex";
}

async function activateNotifications() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;
  try {
    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swRegistration });
    await setDoc(doc(db, "device", "current"), { fcmToken: token, ownerUid: currentUid, updatedAt: serverTimestamp() });
    document.getElementById("notif-banner").style.display = "none";
  } catch (e) {
    console.error("Erro ao ativar notificações:", e);
  }
}

// ---------- dados: metas ----------

function listenGoals() {
  const q = query(collection(db, "goals"), where("ownerUid", "==", currentUid));
  onSnapshot(q, (snap) => {
    goals = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (activeTab === "metas") renderMetas();
    if (activeTab === "hoje") renderHoje();
  });
}

async function deleteGoal(id) {
  if (!confirm("Apagar essa meta?")) return;
  await deleteDoc(doc(db, "goals", id));
}

// ---------- dados: progresso do dia ----------

function listenCompletions() {
  const q = query(collection(db, "completions"), where("ownerUid", "==", currentUid));
  onSnapshot(q, (snap) => {
    allCompletions = snap.docs.map((d) => d.data());
    const t = todayISO();
    completions = {};
    allCompletions.forEach((c) => { if (c.date === t) completions[c.goalId] = c; });
    if (activeTab === "hoje") renderHoje();
    if (activeTab === "progresso") renderProgresso();
  });
}

async function toggleDone(goalId) {
  const current = completions[goalId]?.done || false;
  await setDoc(doc(db, "completions", `${goalId}_${todayISO()}`), {
    ownerUid: currentUid, goalId, date: todayISO(), done: !current,
  }, { merge: true });
}

async function incrementCheckin(goalId, total) {
  const current = completions[goalId]?.count || 0;
  const next = Math.min(total, current + 1);
  await setDoc(doc(db, "completions", `${goalId}_${todayISO()}`), {
    ownerUid: currentUid, goalId, date: todayISO(), count: next,
  }, { merge: true });
}

// ---------- dados: corpo (peso, medidas, ciclo) ----------

function listenBodyData() {
  onSnapshot(query(collection(db, "bodyWeight"), where("ownerUid", "==", currentUid)), (snap) => {
    weightEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.dateISO.localeCompare(b.dateISO));
    if (activeTab === "progresso") renderProgresso();
  });
  onSnapshot(query(collection(db, "bodyMeasurements"), where("ownerUid", "==", currentUid)), (snap) => {
    measurementEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.dateISO.localeCompare(b.dateISO));
    if (activeTab === "progresso") renderProgresso();
  });
  onSnapshot(query(collection(db, "cycleEntries"), where("ownerUid", "==", currentUid)), (snap) => {
    cycleEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.dateISO.localeCompare(b.dateISO));
    if (activeTab === "progresso") renderProgresso();
  });
}

async function logWeight(kg) {
  await addDoc(collection(db, "bodyWeight"), { ownerUid: currentUid, dateISO: todayISO(), kg, createdAt: serverTimestamp() });
}
async function logMeasurements(vals) {
  await addDoc(collection(db, "bodyMeasurements"), { ownerUid: currentUid, dateISO: todayISO(), ...vals, createdAt: serverTimestamp() });
}
async function logCycle(dateISO) {
  await addDoc(collection(db, "cycleEntries"), { ownerUid: currentUid, dateISO, createdAt: serverTimestamp() });
}

// ---------- navegação de abas ----------

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll("nav.tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "metas") renderMetas();
  else if (tab === "hoje") renderHoje();
  else renderProgresso();
}

// ---------- render: Hoje ----------

function renderHoje() {
  const todays = goals.filter(isActiveToday);
  const doneFlags = todays.map((g) => {
    if (g.type === "intervalo") {
      const total = computeIntervaloTotal(g);
      return (completions[g.id]?.count || 0) >= total;
    }
    return !!completions[g.id]?.done;
  });
  const doneCount = doneFlags.filter(Boolean).length;
  const pct = todays.length ? Math.round((doneCount / todays.length) * 100) : 0;
  const circumference = 2 * Math.PI * 54;
  const offset = circumference - (pct / 100) * circumference;

  let html = `
    <div style="text-align:center; padding-top:8px;">
      <div style="font-size:12.5px; color:var(--muted); margin-bottom:14px;">${formatTodayLabel()}</div>
      <div style="position:relative; width:150px; height:150px; margin:0 auto;">
        <svg width="150" height="150" style="transform:rotate(-90deg);">
          <circle cx="75" cy="75" r="54" stroke="var(--surfaceHi)" stroke-width="14" fill="none"/>
          <circle cx="75" cy="75" r="54" stroke="var(--lime)" stroke-width="14" fill="none"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round"/>
        </svg>
        <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;">
          <div style="font-family:'Big Shoulders Display'; font-weight:800; font-size:36px; line-height:1;">${pct}%</div>
          <div style="font-size:10.5px; color:var(--muted); margin-top:2px;">hoje concluído</div>
        </div>
      </div>
    </div>
    <div class="row-header" style="margin-top:20px; margin-bottom:12px;">
      <span style="font-family:'Big Shoulders Display'; font-weight:700; font-size:17px;">PRA HOJE</span>
      <span style="font-family:'JetBrains Mono'; font-size:12px; color:var(--muted);">${doneCount}/${todays.length}</span>
    </div>
  `;

  if (!todays.length) {
    html += `<div class="empty-msg">Nada agendado pra hoje.</div>`;
  }

  for (const g of todays) {
    html += hojeCardHTML(g);
  }

  tabContent.innerHTML = html;

  tabContent.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => toggleDone(btn.dataset.toggle));
  });
  tabContent.querySelectorAll("[data-checkin]").forEach((btn) => {
    btn.addEventListener("click", () => incrementCheckin(btn.dataset.checkin, Number(btn.dataset.total)));
  });
}

function formatTodayLabel() {
  const d = new Date();
  const dias = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  return `${dias[d.getDay()]}, ${d.getDate()}/${d.getMonth() + 1}`;
}

function hojeCardHTML(g) {
  if (g.type === "intervalo") {
    const total = computeIntervaloTotal(g);
    const count = completions[g.id]?.count || 0;
    const maxed = count >= total;
    const pct = Math.round((count / total) * 100);
    return `
      <div class="goal-card" style="flex-direction:column; align-items:stretch; gap:8px;">
        <div style="display:flex; align-items:center; gap:10px;">
          <div class="goal-title">${escapeHTML(g.title)}</div>
          <button data-checkin="${g.id}" data-total="${total}" ${maxed ? "disabled" : ""}
            style="min-width:34px; height:30px; padding:0 10px; border-radius:15px; border:1.5px solid ${maxed ? "var(--lime)" : "var(--border)"}; background:${maxed ? "var(--lime)" : "var(--surfaceHi)"}; color:${maxed ? "#0D0A12" : "var(--lime)"}; font-family:'JetBrains Mono'; font-weight:700; font-size:12px; cursor:pointer;">
            ${maxed ? "✓" : `${count}/${total}`}
          </button>
        </div>
        <div style="height:6px; border-radius:4px; background:var(--border); overflow:hidden;">
          <div style="width:${pct}%; height:100%; background:linear-gradient(90deg, var(--accent), var(--lime));"></div>
        </div>
      </div>
    `;
  }

  const done = !!completions[g.id]?.done;
  return `
    <div class="goal-card">
      <div class="goal-title">${escapeHTML(g.title)}</div>
      <div class="goal-time">${g.time || ""}</div>
      <button data-toggle="${g.id}"
        style="width:32px; height:32px; border-radius:50%; border:1.5px solid ${done ? "var(--lime)" : "var(--border)"}; background:${done ? "var(--lime)" : "transparent"}; color:${done ? "#0D0A12" : "var(--muted)"}; font-weight:700; cursor:pointer;">
        ✓
      </button>
    </div>
  `;
}

// ---------- histórico (usado por streak, semanas e resumo mensal) ----------

function isoFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isActiveOnDate(g, d) {
  const dateISO = isoFromDate(d);
  if (g.createdAt?.toDate) {
    const createdISO = isoFromDate(g.createdAt.toDate());
    if (dateISO < createdISO) return false;
  }
  if (g.type === "checklist") return (g.weekdays || []).includes(d.getDay());
  if (g.type === "daily") return true;
  if (g.type === "intervalo") return true;
  if (g.type === "avulso") return g.date === dateISO;
  if (g.type === "mensal") return g.dayOfMonth === d.getDate();
  return false;
}

function isDoneForDate(g, dateISO) {
  const c = allCompletions.find((x) => x.goalId === g.id && x.date === dateISO);
  if (g.type === "intervalo") return (c?.count || 0) >= computeIntervaloTotal(g);
  return !!c?.done;
}

function buildHistory(daysBack) {
  const days = [];
  const today = new Date();
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateISO = isoFromDate(d);
    const items = goals.filter((g) => isActiveOnDate(g, d)).map((g) => ({ goal: g, done: isDoneForDate(g, dateISO) }));
    days.push({ dateISO, date: d, weekday: d.getDay(), items });
  }
  return days; // ordem crescente, último = hoje
}

function computeCurrentStreak(history) {
  let streak = 0;
  for (let i = history.length - 2; i >= 0; i--) { // começa em ontem, hoje não conta enquanto o dia não fechar
    const day = history[i];
    if (day.items.length === 0) continue;
    if (day.items.every((it) => it.done)) streak++;
    else break;
  }
  return streak;
}

function computeLongestStreak(history) {
  let longest = 0, run = 0;
  for (const day of history) {
    if (day.items.length === 0) continue;
    if (day.items.every((it) => it.done)) { run++; longest = Math.max(longest, run); }
    else run = 0;
  }
  return longest;
}

function buildWeeks(history) {
  const weeks = [];
  for (let start = history.length - 7; start >= 0; start -= 7) {
    weeks.unshift(history.slice(start, start + 7));
  }
  return weeks;
}

function weekPct(chunk) {
  const total = chunk.reduce((s, d) => s + d.items.length, 0);
  const done = chunk.reduce((s, d) => s + d.items.filter((it) => it.done).length, 0);
  return total ? Math.round((done / total) * 100) : 0;
}

function monthCategorySummary(history) {
  const monthPrefix = todayISO().slice(0, 7);
  const cats = { academia: { done: 0, total: 0 }, saude: { done: 0, total: 0 }, domestico: { done: 0, total: 0 }, outros: { done: 0, total: 0 } };
  history.filter((d) => d.dateISO.startsWith(monthPrefix)).forEach((d) => {
    d.items.forEach((it) => {
      const c = cats[it.goal.cat] || cats.outros;
      c.total++;
      if (it.done) c.done++;
    });
  });
  return Object.entries(cats).map(([cat, v]) => ({ cat, pct: v.total ? Math.round((v.done / v.total) * 100) : 0, total: v.total }));
}

const DAY_LABELS_PT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const WEEK_ROW_LABELS = ["Sem 1", "Sem 2", "Sem 3", "Sem 4 (atual)"];

// ---------- render: Progresso ----------

function renderProgresso() {
  const history = buildHistory(28);
  const currentStreak = computeCurrentStreak(history);
  const longestStreak = computeLongestStreak(history);
  const weeks = buildWeeks(history).slice(-4);

  let html = `
    <h1 class="page-title">PROGRESSO</h1>

    <div class="goal-card" style="gap:14px; padding:16px;">
      <div style="width:48px; height:48px; border-radius:14px; background:linear-gradient(135deg, var(--accent), var(--accentLight)); display:flex; align-items:center; justify-content:center; font-size:22px; flex-shrink:0;">🔥</div>
      <div>
        <div style="font-family:'Big Shoulders Display'; font-weight:800; font-size:26px; line-height:1;">${currentStreak} dias</div>
        <div style="font-size:11.5px; color:var(--muted); margin-top:2px;">streak atual · maior: ${longestStreak} dias</div>
      </div>
    </div>

    ${bodySectionHTML()}

    <div class="section-label" style="margin-top:14px;">Semanas</div>
  `;

  weeks.forEach((chunk, i) => {
    const pct = weekPct(chunk);
    const label = WEEK_ROW_LABELS[WEEK_ROW_LABELS.length - weeks.length + i] || `Sem ${i + 1}`;
    html += `
      <button class="week-row" data-week="${i}" style="width:100%; display:flex; align-items:center; gap:10px; background:transparent; border:none; padding:6px 0; cursor:pointer; color:inherit;">
        <span style="font-size:12px; color:var(--muted); width:78px; text-align:left; flex-shrink:0;">${label}</span>
        <div style="flex:1; height:8px; border-radius:4px; background:var(--border); overflow:hidden;">
          <div style="width:${pct}%; height:100%; background:linear-gradient(90deg, var(--accent), var(--lime));"></div>
        </div>
        <span style="font-family:'JetBrains Mono'; font-size:11.5px; width:32px; text-align:right;">${pct}%</span>
      </button>
    `;
  });

  html += `
    <button id="btn-month-summary" style="width:100%; display:flex; align-items:center; gap:12px; margin-top:16px; background:linear-gradient(135deg, rgba(148,9,183,.15), rgba(48,216,238,.08)); border:1px solid rgba(193,63,224,.4); border-radius:16px; padding:14px 16px; text-align:left; cursor:pointer; color:inherit;">
      <div style="width:36px; height:36px; border-radius:10px; background:var(--surfaceHi); display:flex; align-items:center; justify-content:center; font-size:16px; flex-shrink:0;">📅</div>
      <div style="flex:1;">
        <div style="font-weight:600; font-size:14px;">Fechar o mês</div>
        <div style="font-size:11.5px; color:var(--muted); margin-top:1px;">Ver resumo por categoria</div>
      </div>
    </button>
  `;

  tabContent.innerHTML = html;

  const bodyToggle = document.getElementById("body-toggle");
  if (bodyToggle) bodyToggle.addEventListener("click", () => { bodyExpanded = !bodyExpanded; renderProgresso(); });
  const btnLogWeight = document.getElementById("btn-log-weight");
  if (btnLogWeight) btnLogWeight.addEventListener("click", openWeightSheet);
  const btnLogMeasure = document.getElementById("btn-log-measure");
  if (btnLogMeasure) btnLogMeasure.addEventListener("click", openMeasurementsSheet);
  const btnLogCycle = document.getElementById("btn-log-cycle");
  if (btnLogCycle) btnLogCycle.addEventListener("click", openCycleSheet);

  tabContent.querySelectorAll("[data-week]").forEach((btn) => {
    btn.addEventListener("click", () => openWeekSheet(weeks[Number(btn.dataset.week)]));
  });
  document.getElementById("btn-month-summary").addEventListener("click", () => openMonthSummarySheet(history));
}

// ---------- seção Corpo (peso, medidas, ciclo) ----------

const MEASURE_LABELS = { cintura: "Cintura", peito: "Peito", braco: "Braço", coxa: "Coxa" };

function addDaysISO(dateISO, n) {
  const d = new Date(dateISO + "T00:00:00");
  d.setDate(d.getDate() + n);
  return isoFromDate(d);
}
function daysBetweenISO(a, b) {
  return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
}

function lineChartSVG(points, color) {
  if (points.length < 2) return `<div style="font-size:11.5px; color:var(--muted); padding:8px 0;">Registra mais um valor pra ver o gráfico.</div>`;
  const w = 280, h = 56, pad = 6;
  const vals = points.map((p) => p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const coords = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = h - pad - ((p.v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const dots = points.map((p, i) => {
    const [x, y] = coords[i].split(",");
    return `<circle cx="${x}" cy="${y}" r="3" fill="${color}" />`;
  }).join("");
  return `
    <svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="overflow:visible;">
      <polyline points="${coords.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
      ${dots}
    </svg>
  `;
}

function bodySectionHTML() {
  const lastWeight = weightEntries[weightEntries.length - 1];
  const firstWeight = weightEntries[0];
  const weightDelta = lastWeight && firstWeight ? (lastWeight.kg - firstWeight.kg).toFixed(1) : null;

  const chevron = bodyExpanded ? "▲" : "▼";
  let inner = "";

  if (bodyExpanded) {
    // --- peso ---
    inner += `
      <div style="margin-top:14px;">
        <div class="row-header" style="margin-bottom:8px;">
          <span class="section-label" style="margin:0;">Peso</span>
          <button class="btn-icon" id="btn-log-weight" style="width:26px; height:26px; font-size:14px; border-radius:8px;">+</button>
        </div>
        ${lastWeight ? `
          <div style="display:flex; align-items:baseline; gap:8px; margin-bottom:6px;">
            <span style="font-family:'Big Shoulders Display'; font-weight:800; font-size:24px;">${lastWeight.kg}kg</span>
            ${weightDelta !== null ? `<span style="font-family:'JetBrains Mono'; font-size:11px; color:${Number(weightDelta) <= 0 ? "var(--lime)" : "var(--gold)"};">${Number(weightDelta) > 0 ? "+" : ""}${weightDelta}kg desde ${formatDateBR(firstWeight.dateISO)}</span>` : ""}
          </div>
        ` : `<div class="empty-msg" style="padding:16px 0;">Nenhum registro ainda.</div>`}
        ${lineChartSVG(weightEntries.slice(-10).map((e) => ({ v: e.kg })), "var(--lime)")}
      </div>
    `;

    // --- medidas ---
    const lastM = measurementEntries[measurementEntries.length - 1];
    const firstM = measurementEntries[0];
    inner += `
      <div style="margin-top:18px;">
        <div class="row-header" style="margin-bottom:8px;">
          <span class="section-label" style="margin:0;">Medidas</span>
          <button class="btn-icon" id="btn-log-measure" style="width:26px; height:26px; font-size:14px; border-radius:8px;">+</button>
        </div>
        ${lastM ? Object.keys(MEASURE_LABELS).map((k) => {
          const cur = lastM[k];
          const delta = firstM ? (cur - firstM[k]) : 0;
          return `
            <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:13px;">
              <span>${MEASURE_LABELS[k]}</span>
              <span style="font-family:'JetBrains Mono';">${cur}cm <span style="color:${delta === 0 ? "var(--muted)" : delta < 0 ? "var(--lime)" : "var(--gold)"};">(${delta > 0 ? "+" : ""}${delta}cm)</span></span>
            </div>
          `;
        }).join("") : `<div class="empty-msg" style="padding:16px 0;">Nenhum registro ainda.</div>`}
      </div>
    `;

    // --- ciclo ---
    const lastCycle = cycleEntries[cycleEntries.length - 1];
    let avgCycle = null, predicted = null;
    if (cycleEntries.length >= 2) {
      const diffs = [];
      for (let i = 1; i < cycleEntries.length; i++) diffs.push(daysBetweenISO(cycleEntries[i - 1].dateISO, cycleEntries[i].dateISO));
      avgCycle = Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length);
      predicted = addDaysISO(lastCycle.dateISO, avgCycle);
    }
    inner += `
      <div style="margin-top:18px;">
        <div class="row-header" style="margin-bottom:8px;">
          <span class="section-label" style="margin:0;">Ciclo menstrual</span>
          <button class="btn-icon" id="btn-log-cycle" style="width:26px; height:26px; font-size:14px; border-radius:8px;">+</button>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:13px; padding:4px 0;">
          <span>Último início</span>
          <span style="font-family:'JetBrains Mono';">${lastCycle ? formatDateBR(lastCycle.dateISO) : "—"}</span>
        </div>
        ${avgCycle ? `
          <div style="display:flex; justify-content:space-between; font-size:13px; padding:4px 0;">
            <span>Ciclo médio</span>
            <span style="font-family:'JetBrains Mono';">${avgCycle} dias</span>
          </div>
          <div style="background:rgba(232,93,156,.12); border:1px solid rgba(232,93,156,.4); border-radius:10px; padding:8px 10px; margin-top:8px; font-size:12px; color:var(--pink);">
            Próximo previsto: <strong>${formatDateBR(predicted)}</strong>
          </div>
        ` : ""}
      </div>
    `;
  }

  return `
    <div class="goal-card" style="flex-direction:column; align-items:stretch; cursor:pointer;" id="body-toggle">
      <div style="display:flex; align-items:center; gap:10px;">
        <div class="goal-title">Corpo</div>
        <div class="goal-time">${lastWeight ? `${lastWeight.kg}kg · ` : ""}peso, medidas & ciclo</div>
        <span style="color:var(--muted); font-size:11px;">${chevron}</span>
      </div>
      ${inner}
    </div>
  `;
}

function openWeightSheet() {
  const last = weightEntries[weightEntries.length - 1];
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-header">
        <span class="sheet-title">REGISTRAR PESO</span>
        <button class="sheet-close" id="close-sheet-weight">✕</button>
      </div>
      <div class="field-group">
        <div class="field-label">Peso de hoje (kg)</div>
        <input type="number" step="0.1" id="f-weight" value="${last ? last.kg : ""}" />
      </div>
      <button class="save-btn" id="save-weight">Salvar registro</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#close-sheet-weight").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#save-weight").addEventListener("click", async () => {
    const val = Number(overlay.querySelector("#f-weight").value);
    if (!val) return;
    await logWeight(val);
    overlay.remove();
  });
}

function openMeasurementsSheet() {
  const last = measurementEntries[measurementEntries.length - 1] || {};
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-header">
        <span class="sheet-title">REGISTRAR MEDIDAS</span>
        <button class="sheet-close" id="close-sheet-measure">✕</button>
      </div>
      ${Object.keys(MEASURE_LABELS).map((k) => `
        <div class="field-group">
          <div class="field-label">${MEASURE_LABELS[k]} (cm)</div>
          <input type="number" step="0.5" id="f-m-${k}" value="${last[k] ?? ""}" />
        </div>
      `).join("")}
      <button class="save-btn" id="save-measure">Salvar medidas</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#close-sheet-measure").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#save-measure").addEventListener("click", async () => {
    const vals = {};
    for (const k of Object.keys(MEASURE_LABELS)) {
      const v = Number(overlay.querySelector(`#f-m-${k}`).value);
      if (!v) { alert("Preenche todas as medidas."); return; }
      vals[k] = v;
    }
    await logMeasurements(vals);
    overlay.remove();
  });
}

function openCycleSheet() {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-header">
        <span class="sheet-title">REGISTRAR CICLO</span>
        <button class="sheet-close" id="close-sheet-cycle">✕</button>
      </div>
      <div class="field-group">
        <div class="field-label">Data de início</div>
        <input type="date" id="f-cycle-date" value="${todayISO()}" />
      </div>
      <button class="save-btn" id="save-cycle">Salvar data</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#close-sheet-cycle").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#save-cycle").addEventListener("click", async () => {
    const val = overlay.querySelector("#f-cycle-date").value;
    if (!val) return;
    await logCycle(val);
    overlay.remove();
  });
}

function openWeekSheet(chunk) {
  const pct = weekPct(chunk);
  let daysHTML = "";
  for (const day of chunk) {
    const [y, m, dd] = day.dateISO.split("-");
    let itemsHTML = day.items.length
      ? day.items.map((it) => `
          <div style="display:flex; align-items:center; gap:8px; padding:4px 0;">
            <span class="dot" style="background:${CATEGORY_COLOR[it.goal.cat]}"></span>
            <span style="flex:1; font-size:13px; ${it.done ? "" : "color:var(--muted); text-decoration:line-through;"}">${escapeHTML(it.goal.title)}</span>
            <span style="font-size:13px;">${it.done ? "✓" : "✕"}</span>
          </div>
        `).join("")
      : `<div style="font-size:12px; color:var(--muted);">Nada agendado</div>`;

    daysHTML += `
      <div class="goal-card" style="flex-direction:column; align-items:stretch; gap:6px;">
        <div style="display:flex; gap:8px; align-items:baseline;">
          <strong style="font-size:13px;">${DAY_LABELS_PT[day.weekday]}</strong>
          <span style="font-family:'JetBrains Mono'; font-size:11px; color:var(--muted);">${dd}/${m}</span>
        </div>
        ${itemsHTML}
      </div>
    `;
  }

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-header">
        <div>
          <div class="sheet-title">DETALHE DA SEMANA</div>
          <div style="font-family:'JetBrains Mono'; font-size:12px; color:var(--lime); margin-top:2px;">${pct}% concluído</div>
        </div>
        <button class="sheet-close" id="close-week-sheet">✕</button>
      </div>
      ${daysHTML}
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#close-week-sheet").addEventListener("click", () => overlay.remove());
}

function openMonthSummarySheet(history) {
  const summary = monthCategorySummary(history).sort((a, b) => b.pct - a.pct);
  const withData = summary.filter((s) => s.total > 0);
  const best = withData[0];
  const worst = withData[withData.length - 1];
  const monthNames = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const monthLabel = monthNames[new Date().getMonth()];

  let barsHTML = summary.map((s) => `
    <div style="margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; margin-bottom:5px; font-size:13px;">
        <span style="text-transform:capitalize;">${s.cat}</span>
        <span style="font-family:'JetBrains Mono'; color:${CATEGORY_COLOR[s.cat]};">${s.pct}%</span>
      </div>
      <div style="height:8px; border-radius:4px; background:var(--border); overflow:hidden;">
        <div style="width:${s.pct}%; height:100%; background:${CATEGORY_COLOR[s.cat]};"></div>
      </div>
    </div>
  `).join("");

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-header">
        <span class="sheet-title">RESUMO DE ${monthLabel.toUpperCase()}</span>
        <button class="sheet-close" id="close-month-sheet">✕</button>
      </div>
      ${barsHTML}
      ${best ? `<div class="goal-card" style="margin-top:6px;">🏆 Melhor categoria: <strong style="text-transform:capitalize; margin-left:4px;">${best.cat}</strong> (${best.pct}%)</div>` : ""}
      ${worst && worst !== best ? `<div class="goal-card">⚠️ Precisa de atenção: <strong style="text-transform:capitalize; margin-left:4px;">${worst.cat}</strong> (${worst.pct}%)</div>` : ""}
      ${!withData.length ? `<div class="empty-msg">Sem dados suficientes ainda esse mês.</div>` : ""}
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#close-month-sheet").addEventListener("click", () => overlay.remove());
}

// ---------- render: Metas ----------

function formatDateBR(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}`;
}

function goalTimeLabel(g) {
  if (g.type === "intervalo") return `a cada ${g.everyHours}h · ${g.intervalStart}–${g.intervalEnd}`;
  const timePart = g.anyTime ? "algum momento" : g.time;
  if (g.type === "avulso") return `${formatDateBR(g.date)} · ${timePart}`;
  if (g.type === "mensal") return `dia ${g.dayOfMonth} · ${timePart}`;
  if (g.type === "checklist") {
    const dias = (g.weekdays || []).map((w) => WEEKDAY_LABELS[w]).join("");
    return `${dias} · ${timePart}`;
  }
  return timePart;
}

function renderMetas() {
  const avulsos = goals.filter((g) => g.type === "avulso").sort((a, b) => a.date.localeCompare(b.date));
  const recorrentes = goals.filter((g) => g.type !== "avulso");
  const cats = ["academia", "saude", "domestico", "outros"];

  let html = `
    <div class="row-header">
      <h1 class="page-title" style="margin:0;">MINHAS METAS</h1>
      <button class="btn-icon" id="btn-add-goal">+</button>
    </div>
  `;

  if (avulsos.length) {
    html += `<div class="section-label">Avulsos</div>`;
    for (const g of avulsos) html += goalCardHTML(g, true);
  }

  for (const cat of cats) {
    const items = recorrentes.filter((g) => g.cat === cat);
    if (!items.length) continue;
    html += `<div class="section-label"><span class="dot" style="background:${CATEGORY_COLOR[cat]}"></span>${cat}</div>`;
    for (const g of items) html += goalCardHTML(g, false);
  }

  if (!goals.length) {
    html += `<div class="empty-msg">Nenhuma meta ainda. Toque em + pra criar a primeira.</div>`;
  }

  tabContent.innerHTML = html;
  document.getElementById("btn-add-goal").addEventListener("click", openAddSheet);
  tabContent.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => deleteGoal(btn.dataset.del));
  });
}

function goalCardHTML(g, isAvulso) {
  return `
    <div class="goal-card${isAvulso ? " avulso" : ""}">
      <div class="goal-title">${escapeHTML(g.title)}</div>
      <div class="goal-time">${goalTimeLabel(g)}</div>
      <button class="goal-del" data-del="${g.id}">✕</button>
    </div>
  `;
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- formulário de cadastro ----------

function openAddSheet() {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-header">
        <span class="sheet-title">NOVA META</span>
        <button class="sheet-close" id="close-sheet">✕</button>
      </div>

      <div class="field-group">
        <div class="field-label">Título</div>
        <input type="text" id="f-title" placeholder="Ex: Treino de perna" />
      </div>

      <div class="field-group">
        <div class="field-label">Categoria</div>
        <div class="pill-row" id="f-cat-row">
          ${["academia", "saude", "domestico", "outros"].map((c) =>
            `<button type="button" class="pill" data-cat="${c}" style="color:${CATEGORY_COLOR[c]}">${c}</button>`
          ).join("")}
        </div>
      </div>

      <div class="field-group">
        <div class="field-label">Tipo</div>
        <div class="pill-row" id="f-type-row">
          ${Object.entries(TYPE_META).map(([k, m]) =>
            `<button type="button" class="pill" data-type="${k}" style="color:${m.color}">${m.label}</button>`
          ).join("")}
        </div>
        <div class="hint" id="f-type-hint"></div>
      </div>

      <div id="f-dynamic"></div>

      <button class="save-btn" id="f-save" disabled>Salvar meta</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const state = { title: "", cat: "academia", type: "checklist", anyTime: false };
  overlay.querySelector('[data-cat="academia"]').classList.add("active");
  overlay.querySelector('[data-type="checklist"]').classList.add("active");

  overlay.querySelector("#close-sheet").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#f-title").addEventListener("input", (e) => { state.title = e.target.value; updateSaveBtn(); });

  overlay.querySelectorAll("#f-cat-row .pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      overlay.querySelectorAll("#f-cat-row .pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.cat = btn.dataset.cat;
    });
  });

  overlay.querySelectorAll("#f-type-row .pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      overlay.querySelectorAll("#f-type-row .pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.type = btn.dataset.type;
      renderDynamicFields(overlay, state);
      updateSaveBtn();
    });
  });

  function updateSaveBtn() {
    overlay.querySelector("#f-save").disabled = !state.title.trim();
  }

  renderDynamicFields(overlay, state);

  overlay.querySelector("#f-save").addEventListener("click", async () => {
    if (!state.title.trim()) return;
    const newGoal = buildGoalFromState(state, overlay);
    if (!newGoal) return;
    await addDoc(collection(db, "goals"), { ...newGoal, ownerUid: currentUid, createdAt: serverTimestamp() });
    overlay.remove();
  });
}

function renderDynamicFields(overlay, state) {
  const hint = overlay.querySelector("#f-type-hint");
  const dyn = overlay.querySelector("#f-dynamic");

  const hints = {
    daily: 'Ex: "lavar louça" — notifica todo dia, sem escolher dias da semana.',
    intervalo: 'Ex: "comer alguma coisa" — te lembra várias vezes ao longo do dia.',
    avulso: 'Ex: "pagar conta de luz" — acontece uma vez só, numa data específica.',
    mensal: 'Ex: "registrar peso" — dispara todo mês, num dia fixo.',
    checklist: "",
  };
  hint.textContent = hints[state.type] || "";

  const whenBlock = (defaultTime = "18:00") => `
    <div class="field-group">
      <div class="field-label">Quando notificar</div>
      <div class="pill-row" style="margin-bottom:10px;">
        <button type="button" class="pill" data-anytime="false" style="color:var(--accentLight)">Horário fixo</button>
        <button type="button" class="pill" data-anytime="true" style="color:var(--gold)">Algum momento</button>
      </div>
      <input type="time" id="f-time" value="${defaultTime}" />
    </div>
  `;

  let html = "";
  if (state.type === "checklist") {
    html += whenBlock();
    html += `
      <div class="field-group">
        <div class="field-label">Dias da semana</div>
        <div class="weekday-row" id="f-weekdays">
          ${WEEKDAY_LABELS.map((d, i) => `<button type="button" class="weekday-btn" data-day="${i}">${d}</button>`).join("")}
        </div>
      </div>
    `;
  } else if (state.type === "daily") {
    html += whenBlock();
  } else if (state.type === "intervalo") {
    html += `
      <div class="field-group">
        <div class="field-label">Janela e frequência</div>
        <div style="display:flex; gap:8px;">
          <input type="time" id="f-int-start" value="07:00" />
          <input type="time" id="f-int-end" value="22:00" />
          <input type="number" id="f-int-every" value="3" min="1" style="width:64px;" />
        </div>
      </div>
    `;
  } else if (state.type === "avulso") {
    html += `
      <div class="field-group">
        <div class="field-label">Data</div>
        <input type="date" id="f-date" />
      </div>
    `;
    html += whenBlock();
  } else if (state.type === "mensal") {
    html += `
      <div class="field-group">
        <div class="field-label">Dia do mês</div>
        <input type="number" id="f-day-of-month" min="1" max="31" value="1" />
      </div>
    `;
    html += whenBlock();
  }

  dyn.innerHTML = html;

  const anyTimeBtns = dyn.querySelectorAll("[data-anytime]");
  anyTimeBtns.forEach((btn) => {
    if (btn.dataset.anytime === "false") btn.classList.add("active");
    btn.addEventListener("click", () => {
      anyTimeBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.anyTime = btn.dataset.anytime === "true";
      const timeInput = dyn.querySelector("#f-time");
      if (timeInput) timeInput.style.display = state.anyTime ? "none" : "block";
    });
  });

  const weekdayRow = dyn.querySelector("#f-weekdays");
  if (weekdayRow) {
    state.weekdays = new Set([1, 3, 5]);
    weekdayRow.querySelectorAll(".weekday-btn").forEach((btn) => {
      const day = Number(btn.dataset.day);
      if (state.weekdays.has(day)) btn.classList.add("active");
      btn.addEventListener("click", () => {
        if (state.weekdays.has(day)) { state.weekdays.delete(day); btn.classList.remove("active"); }
        else { state.weekdays.add(day); btn.classList.add("active"); }
      });
    });
  }
}

function buildGoalFromState(state, overlay) {
  const base = { title: state.title.trim(), cat: state.cat, type: state.type };

  if (state.type === "checklist") {
    return { ...base, weekdays: Array.from(state.weekdays || [1, 3, 5]), anyTime: state.anyTime, time: overlay.querySelector("#f-time").value, anyTimeWindow: ["09:00", "21:00"] };
  }
  if (state.type === "daily") {
    return { ...base, anyTime: state.anyTime, time: overlay.querySelector("#f-time").value, anyTimeWindow: ["09:00", "21:00"] };
  }
  if (state.type === "intervalo") {
    return {
      ...base,
      intervalStart: overlay.querySelector("#f-int-start").value,
      intervalEnd: overlay.querySelector("#f-int-end").value,
      everyHours: Number(overlay.querySelector("#f-int-every").value) || 1,
    };
  }
  if (state.type === "avulso") {
    const date = overlay.querySelector("#f-date").value;
    if (!date) { alert("Escolhe uma data."); return null; }
    return { ...base, date, anyTime: state.anyTime, time: overlay.querySelector("#f-time").value, anyTimeWindow: ["09:00", "21:00"] };
  }
  if (state.type === "mensal") {
    return {
      ...base,
      dayOfMonth: Number(overlay.querySelector("#f-day-of-month").value) || 1,
      anyTime: state.anyTime,
      time: overlay.querySelector("#f-time").value,
      anyTimeWindow: ["09:00", "21:00"],
    };
  }
  return base;
}

boot();
