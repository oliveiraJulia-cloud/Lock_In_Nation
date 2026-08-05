import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, collection, query, where, onSnapshot,
  addDoc, deleteDoc, doc, serverTimestamp,
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
let activeTab = "metas";
let unsubscribeGoals = null;

const tabContent = document.getElementById("tab-content");

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
  if (Notification.permission !== "granted") {
    banner.style.display = "flex";
  }
}

async function activateNotifications() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;
  try {
    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swRegistration });
    const { setDoc, doc: docRef } = await import("https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js");
    await setDoc(docRef(db, "device", "current"), { fcmToken: token, ownerUid: currentUid, updatedAt: serverTimestamp() });
    document.getElementById("notif-banner").style.display = "none";
  } catch (e) {
    console.error("Erro ao ativar notificações:", e);
  }
}

function listenGoals() {
  const q = query(collection(db, "goals"), where("ownerUid", "==", currentUid));
  unsubscribeGoals = onSnapshot(q, (snap) => {
    goals = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (activeTab === "metas") renderMetas();
  });
}

async function deleteGoal(id) {
  if (!confirm("Apagar essa meta?")) return;
  await deleteDoc(doc(db, "goals", id));
}

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll("nav.tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "metas") renderMetas();
  else renderPlaceholder(tab);
}

function renderPlaceholder(tab) {
  const label = tab === "hoje" ? "Hoje" : "Progresso";
  tabContent.innerHTML = `<div class="placeholder">A aba "${label}" ainda está sendo construída — chega na próxima etapa 🚧</div>`;
}

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
