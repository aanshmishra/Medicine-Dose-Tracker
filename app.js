import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
  deleteField,
  FieldPath,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th"];

// ---------- Date helpers (local time, not UTC) ----------
function todayStr(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysBetween(fromStr, toStr) {
  const [y1, m1, d1] = fromStr.split("-").map(Number);
  const [y2, m2, d2] = toStr.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// ---------- Patient ID (lives in the share link) ----------
function randomId(len = 20) {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

const params = new URLSearchParams(location.search);
let patientId = params.get("patient");
if (!patientId || patientId.length < 16) {
  patientId = randomId();
  params.set("patient", patientId);
  history.replaceState(null, "", `${location.pathname}?${params}`);
}

// ---------- Firebase ----------
const app = initializeApp(firebaseConfig);
// Local cache lets the app keep working on spotty Wi-Fi; changes sync when back online.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
const patientRef = doc(db, "patients", patientId);

// ---------- State ----------
// Shared across all nurses (Firestore document):
//   startDays, startDate          – days-left baseline
//   doses: { "2026-10-30": { "4_0": true, ... } }  – keyed by date, so each day starts fresh
//   reminders: { "4_0": "08:30" }
let shared = null; // null until the first snapshot arrives

// Per-phone only (localStorage):
const LOCAL_KEY = `medicineTracker:${patientId}`;
let local = { activeTab: 1, notified: {} }; // notified: "4_0" -> last date this phone alerted
try {
  local = { ...local, ...JSON.parse(localStorage.getItem(LOCAL_KEY)) };
} catch {}

function saveLocal() {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
}

function daysLeft() {
  if (shared?.startDays == null) return null;
  return Math.max(0, shared.startDays - daysBetween(shared.startDate, todayStr()));
}

function isTaken(n, i) {
  return !!shared?.doses?.[todayStr()]?.[`${n}_${i}`];
}

// ---------- Writes ----------
function reportError(err) {
  console.error(err);
  showToast("Couldn't save — check your connection and try again.");
}

let justToggled = null; // animate only the dose that was just tapped

function toggleDose(n, i) {
  justToggled = `${n}_${i}`;
  updateDoc(patientRef, new FieldPath("doses", todayStr(), `${n}_${i}`), !isTaken(n, i))
    .catch(reportError);
}

function setReminder(key, time) {
  updateDoc(patientRef, new FieldPath("reminders", key), time ?? deleteField())
    .catch(reportError);
}

// ---------- Rendering ----------
const els = {
  daysLeftBtn: document.getElementById("days-left"),
  daysLeftNum: document.getElementById("days-left-number"),
  shareBtn: document.getElementById("share-btn"),
  themeBtn: document.getElementById("theme-btn"),
  tabs: document.querySelectorAll(".tab"),
  tabCounts: document.querySelectorAll(".tab-count"),
  todayLabel: document.getElementById("today-label"),
  progressCount: document.getElementById("progress-count"),
  progressFill: document.getElementById("progress-fill"),
  allDone: document.getElementById("all-done"),
  doseList: document.getElementById("dose-list"),
  setup: document.getElementById("setup"),
  setupForm: document.getElementById("setup-form"),
  setupDays: document.getElementById("setup-days"),
  toast: document.getElementById("toast"),
};

function formatTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

let renderedDate = todayStr();

function render() {
  renderedDate = todayStr();

  const left = daysLeft();
  els.daysLeftNum.textContent = left ?? "–";
  els.daysLeftBtn.classList.toggle("low", left != null && left <= 3);

  els.tabs.forEach((t) => t.classList.toggle("active", Number(t.dataset.tab) === local.activeTab));

  if (!shared) {
    els.todayLabel.textContent = "Loading…";
    els.allDone.classList.add("hidden");
    els.doseList.innerHTML = "";
    return;
  }

  els.todayLabel.textContent = new Date().toLocaleDateString([], {
    weekday: "long", month: "long", day: "numeric",
  });

  els.tabCounts.forEach((el) => {
    const count = Number(el.dataset.count);
    let done = 0;
    for (let i = 0; i < count; i++) if (isTaken(count, i)) done++;
    el.textContent = `${done}/${count}`;
    el.classList.toggle("complete", done === count);
  });

  const n = local.activeTab;
  const doses = Array.from({ length: n }, (_, i) => isTaken(n, i));
  const doneCount = doses.filter(Boolean).length;
  els.progressCount.textContent = `${doneCount} of ${n} taken`;
  els.progressFill.style.width = `${(doneCount / n) * 100}%`;
  els.allDone.classList.toggle("hidden", doneCount !== n);

  els.doseList.innerHTML = "";
  doses.forEach((taken, i) => {
    const key = `${n}_${i}`;
    const reminder = shared.reminders?.[key];

    const li = document.createElement("li");
    li.className = "dose";

    const toggle = document.createElement("button");
    toggle.className = "dose-toggle" + (taken ? " taken" : "") + (justToggled === key ? " bump" : "");
    toggle.innerHTML = `
      <span class="dose-num">${taken ? "✓" : i + 1}</span>
      <span class="dose-text">
        <span class="dose-title">${ORDINALS[i]} dose</span>
        <span class="dose-status">${taken ? "Taken" : "Not taken yet"}</span>
      </span>`;
    toggle.addEventListener("click", () => toggleDose(n, i));

    const rem = document.createElement("div");
    rem.className = "reminder";

    const remBtn = document.createElement("button");
    remBtn.className = "reminder-btn" + (reminder ? " set" : "");
    remBtn.textContent = reminder ? `🔔 ${formatTime(reminder)}` : "🔔 Remind me";

    const timeInput = document.createElement("input");
    timeInput.type = "time";
    timeInput.className = "hidden";
    timeInput.value = reminder || "";

    remBtn.addEventListener("click", () => {
      remBtn.classList.add("hidden");
      timeInput.classList.remove("hidden");
      timeInput.focus();
      timeInput.showPicker?.();
    });
    timeInput.addEventListener("change", () => {
      if (!timeInput.value) return;
      // If the chosen time already passed today, start reminding from tomorrow.
      const [h, m] = timeInput.value.split(":").map(Number);
      const now = new Date();
      if (h * 60 + m <= now.getHours() * 60 + now.getMinutes()) {
        local.notified[key] = todayStr();
      } else {
        delete local.notified[key];
      }
      saveLocal();
      setReminder(key, timeInput.value);
      requestNotificationPermission();
    });
    timeInput.addEventListener("blur", () => setTimeout(render, 150));

    rem.append(remBtn, timeInput);

    if (reminder) {
      const clear = document.createElement("button");
      clear.className = "clear-btn";
      clear.title = "Remove reminder";
      clear.textContent = "✕";
      clear.addEventListener("click", () => setReminder(key, null));
      rem.append(clear);
    }

    li.append(toggle, rem);
    els.doseList.append(li);
  });
  justToggled = null;
}

// ---------- Dark mode ----------
const THEME_KEY = "medicineTracker:theme";

els.themeBtn.addEventListener("click", () => {
  const current = document.documentElement.dataset.theme
    ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch {}
});

// ---------- Setup (first open / edit days) ----------
function openSetup() {
  els.setupDays.value = daysLeft() ?? "";
  els.setup.classList.remove("hidden");
  els.setupDays.focus();
}

els.setupForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const value = parseInt(els.setupDays.value, 10);
  if (Number.isNaN(value) || value < 0) return;
  setDoc(patientRef, { startDays: value, startDate: todayStr() }, { merge: true })
    .catch(reportError);
  els.setup.classList.add("hidden");
});

els.daysLeftBtn.addEventListener("click", openSetup);

els.tabs.forEach((t) =>
  t.addEventListener("click", () => {
    local.activeTab = Number(t.dataset.tab);
    saveLocal();
    render();
  })
);

// ---------- Share link with the other nurses ----------
els.shareBtn.addEventListener("click", async () => {
  const url = location.href;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Medicine Tracker", url });
    } catch {}
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link copied — send it to the other nurses.");
  } catch {
    prompt("Copy this link and send it to the other nurses:", url);
  }
});

// ---------- Reminders ----------
function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.add("hidden"), 10000);
}

function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
  showToast(`${title} — ${body}`);
}

function checkReminders() {
  if (!shared) return;
  const now = new Date();
  const today = todayStr(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const [key, time] of Object.entries(shared.reminders ?? {})) {
    if (local.notified[key] === today) continue;
    const [h, m] = time.split(":").map(Number);
    if (nowMinutes < h * 60 + m) continue;

    const [n, i] = key.split("_").map(Number);
    local.notified[key] = today;
    saveLocal();
    // Skip the alert if any nurse already marked the dose taken.
    if (isTaken(n, i)) continue;
    notify("Time for medicine 💊", `${ORDINALS[i]} dose of ${n}x medicine`);
  }
}

// ---------- Init ----------
render();

onSnapshot(
  patientRef,
  (snap) => {
    const firstLoad = shared === null;
    shared = snap.data() ?? {};
    render();
    checkReminders();
    if (firstLoad && shared.startDays == null) openSetup();
  },
  (err) => {
    console.error(err);
    els.todayLabel.textContent = "Not connected";
    showToast("Couldn't connect to the database. Check that Firestore is created and the rules are published.");
  }
);

setInterval(() => {
  if (todayStr() !== renderedDate) render(); // new day → everything shows red again
  checkReminders();
}, 20000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) render();
});
