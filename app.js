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

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

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

function shortDate(daysFromToday) {
  if (daysFromToday === 0) return "today";
  if (daysFromToday === 1) return "tomorrow";
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
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
//   patient: { name, code }       – entered on first open; the tracker stays hidden until set
//   builtinTabs: false            – set for patients created after the 1x/4x/6x tabs were retired
//   builtins: { "4": { name, notes } } – nurse-given name and notes for the 1x/4x/6x tabs
//   courses: { "4": { startDays, startDate }, "m3k…": … }  – days-left baseline per tab
//   startDays, startDate          – old patient-wide days-left baseline (fallback for tabs without a course)
//   doses: { "2026-10-30": { "4_0": true, ... } }  – keyed by date, so each day starts fresh
//   reminders: { "4_0": "08:30" }
//   medicines: { "m3k…": { name, everyDays, dosesPerDay, notes, startDate, createdAt } } – added via "+"
// Dose/reminder keys are `${tabId}_${doseIndex}`; tab IDs never contain "_".
let shared = null; // null until the first snapshot arrives

// Per-phone only (localStorage):
const LOCAL_KEY = `medicineTracker:${patientId}`;
let local = { activeTab: "1", notified: {} }; // notified: "4_0" -> last date this phone alerted
try {
  local = { ...local, ...JSON.parse(localStorage.getItem(LOCAL_KEY)) };
} catch {}
local.activeTab = String(local.activeTab); // older versions stored a number

function saveLocal() {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
}

function hasPatientDetails() {
  return !!(shared?.patient?.name && shared?.patient?.code);
}

function courseOf(tabId) {
  if (shared?.courses?.[tabId]) return shared.courses[tabId];
  if (shared?.startDays != null) return { startDays: shared.startDays, startDate: shared.startDate };
  return null;
}

function daysLeft(tabId) {
  const c = courseOf(tabId);
  if (!c) return null;
  return Math.max(0, c.startDays - daysBetween(c.startDate, todayStr()));
}

// ---------- Tabs (built-in 1x/4x/6x for older patients + medicines added by nurses) ----------
const BUILTIN_TABS = [1, 4, 6].map((n) => ({
  id: String(n), name: `${n}x`, label: `${n}x medicine`, dosesPerDay: n, everyDays: 1,
}));

function allTabs() {
  const builtins = shared?.builtinTabs === false ? [] : BUILTIN_TABS.map((t) => {
    const extra = shared?.builtins?.[t.id] ?? {};
    return { ...t, ...extra, label: extra.name ?? t.label, renamed: !!extra.name };
  });
  const custom = Object.entries(shared?.medicines ?? {})
    .map(([id, m]) => ({ id, custom: true, label: m.name, ...m }))
    .sort((a, b) => a.createdAt - b.createdAt);
  return [...builtins, ...custom];
}

function findTab(id) {
  return allTabs().find((t) => t.id === id);
}

function isDueToday(tab) {
  if (tab.everyDays <= 1) return true;
  const elapsed = daysBetween(tab.startDate, todayStr());
  return elapsed >= 0 && elapsed % tab.everyDays === 0;
}

function nextDueLabel(tab) {
  const elapsed = daysBetween(tab.startDate, todayStr());
  return shortDate(elapsed < 0 ? -elapsed : tab.everyDays - (elapsed % tab.everyDays));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function everyText(everyDays) {
  return everyDays === 1 ? "every day" : `every ${everyDays} days`;
}

function scheduleText(everyDays, dosesPerDay) {
  return `${plural(dosesPerDay, "dose")} ${everyText(everyDays)}`;
}

function isTaken(tabId, i) {
  return !!shared?.doses?.[todayStr()]?.[`${tabId}_${i}`];
}

// ---------- Writes ----------
function reportError(err) {
  console.error(err);
  showToast("Couldn't save — check your connection and try again.");
}

let justToggled = null; // animate only the dose that was just tapped

function toggleDose(tabId, i) {
  justToggled = `${tabId}_${i}`;
  updateDoc(patientRef, new FieldPath("doses", todayStr(), `${tabId}_${i}`), !isTaken(tabId, i))
    .catch(reportError);
}

function setReminder(key, time) {
  updateDoc(patientRef, new FieldPath("reminders", key), time ?? deleteField())
    .catch(reportError);
}

function addMedicine({ name, everyDays, dosesPerDay, notes, totalDays }) {
  const id = "m" + randomId(10);
  const medicine = { name, everyDays, dosesPerDay, notes, startDate: todayStr(), createdAt: Date.now() };
  const course = { startDays: totalDays, startDate: todayStr() };
  setDoc(patientRef, { medicines: { [id]: medicine }, courses: { [id]: course } }, { merge: true })
    .catch(reportError);
  return id;
}

// Name and notes live under "medicines" for added medicines and "builtins" for 1x/4x/6x.
function updateTabField(tab, field, value) {
  const root = tab.custom ? "medicines" : "builtins";
  // Apply locally first so the change shows right away; the snapshot confirms it.
  ((shared[root] ??= {})[tab.id] ??= {})[field] = value;
  updateDoc(patientRef, new FieldPath(root, tab.id, field), value).catch(reportError);
}

// Field/value pairs that delete this tab's reminders from dose index `from` onwards.
function reminderDeletes(tabId, from = 0) {
  const fields = [];
  for (const key of Object.keys(shared.reminders ?? {})) {
    const [id, i] = key.split("_");
    if (id === tabId && Number(i) >= from) fields.push(new FieldPath("reminders", key), deleteField());
  }
  return fields;
}

function removeMedicine(id) {
  updateDoc(
    patientRef,
    new FieldPath("medicines", id), deleteField(),
    new FieldPath("courses", id), deleteField(),
    ...reminderDeletes(id),
  ).catch(reportError);
}

// ---------- Rendering ----------
const els = {
  boot: document.getElementById("boot"),
  bootText: document.getElementById("boot-text"),
  welcome: document.getElementById("welcome"),
  welcomeForm: document.getElementById("welcome-form"),
  welcomeName: document.getElementById("welcome-name"),
  welcomeCode: document.getElementById("welcome-code"),
  patientName: document.getElementById("patient-name"),
  daysLeftBtn: document.getElementById("days-left"),
  daysLeftNum: document.getElementById("days-left-number"),
  daysLeftLabel: document.getElementById("days-left-label"),
  shareBtn: document.getElementById("share-btn"),
  themeBtn: document.getElementById("theme-btn"),
  tabs: document.getElementById("tabs"),
  todayLabel: document.getElementById("today-label"),
  progressTitle: document.getElementById("progress-title"),
  progressSub: document.getElementById("progress-sub"),
  progressCount: document.getElementById("progress-count"),
  progressFill: document.getElementById("progress-fill"),
  allDone: document.getElementById("all-done"),
  notDue: document.getElementById("not-due"),
  notDueText: document.getElementById("not-due-text"),
  doseList: document.getElementById("dose-list"),
  removeBtn: document.getElementById("remove-btn"),
  empty: document.getElementById("empty"),
  emptyAdd: document.getElementById("empty-add"),
  tracker: document.getElementById("tracker"),
  tabActions: document.getElementById("tab-actions"),
  scheduleBtn: document.getElementById("schedule-btn"),
  notesBtn: document.getElementById("notes-btn"),
  renameBtn: document.getElementById("rename-btn"),
  schedule: document.getElementById("schedule"),
  scheduleTitle: document.getElementById("schedule-title"),
  scheduleView: document.getElementById("schedule-view"),
  scheduleEdit: document.getElementById("schedule-edit"),
  scheduleEditBtn: document.getElementById("schedule-edit-btn"),
  scheduleDiscard: document.getElementById("schedule-discard"),
  scheduleClose: document.getElementById("schedule-close"),
  statDays: document.getElementById("stat-days"),
  statDaysMeta: document.getElementById("stat-days-meta"),
  statEvery: document.getElementById("stat-every"),
  statEveryMeta: document.getElementById("stat-every-meta"),
  statDoses: document.getElementById("stat-doses"),
  statDosesMeta: document.getElementById("stat-doses-meta"),
  schedDays: document.getElementById("sched-days"),
  schedEvery: document.getElementById("sched-every"),
  schedDoses: document.getElementById("sched-doses"),
  schedCustom: document.getElementById("sched-custom"),
  schedFixed: document.getElementById("sched-fixed"),
  notes: document.getElementById("notes"),
  notesTitle: document.getElementById("notes-title"),
  notesView: document.getElementById("notes-view"),
  notesInput: document.getElementById("notes-input"),
  notesEdit: document.getElementById("notes-edit"),
  notesDiscard: document.getElementById("notes-discard"),
  notesClose: document.getElementById("notes-close"),
  rename: document.getElementById("rename"),
  renameForm: document.getElementById("rename-form"),
  renameInput: document.getElementById("rename-input"),
  renameCancel: document.getElementById("rename-cancel"),
  addBtn: document.getElementById("add-btn"),
  addScreen: document.getElementById("add-screen"),
  addForm: document.getElementById("add-form"),
  addBack: document.getElementById("add-back"),
  addName: document.getElementById("add-name"),
  addEvery: document.getElementById("add-every"),
  addDoses: document.getElementById("add-doses"),
  addDuration: document.getElementById("add-duration"),
  addUnit: document.getElementById("add-unit"),
  addNotes: document.getElementById("add-notes"),
  addSummary: document.getElementById("add-summary"),
  toast: document.getElementById("toast"),
};

function formatTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function renderTabs(tabs, activeId) {
  const scroll = els.tabs.scrollLeft;
  els.tabs.innerHTML = "";
  for (const tab of tabs) {
    const btn = document.createElement("button");
    btn.className = "tab" + (tab.id === activeId ? " active" : "");
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", tab.id === activeId);

    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = tab.name;

    const count = document.createElement("span");
    count.className = "tab-count";
    if (shared) {
      if (isDueToday(tab)) {
        let done = 0;
        for (let i = 0; i < tab.dosesPerDay; i++) if (isTaken(tab.id, i)) done++;
        count.textContent = `${done}/${tab.dosesPerDay}`;
        count.classList.toggle("complete", done === tab.dosesPerDay);
      } else {
        count.textContent = "off";
        count.title = "Not due today";
      }
    }

    btn.append(name, count);
    btn.addEventListener("click", () => selectTab(tab.id));
    els.tabs.append(btn);
  }
  els.tabs.scrollLeft = scroll;
  // Bring a newly active tab into view (an added medicine only appears once the snapshot lands).
  if (activeId !== renderTabs.lastActive) {
    renderTabs.lastActive = activeId;
    els.tabs.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
}

function selectTab(id) {
  local.activeTab = id;
  saveLocal();
  render();
}

let renderedDate = todayStr();

function renderGate() {
  const ready = hasPatientDetails();
  document.body.classList.toggle("locked", !ready);
  els.boot.classList.toggle("hidden", !!shared);
  const showWelcome = !!shared && !ready;
  if (showWelcome && els.welcome.classList.contains("hidden")) {
    els.welcome.classList.remove("hidden");
    els.welcomeName.focus();
  } else if (!showWelcome) {
    els.welcome.classList.add("hidden");
  }
  return ready;
}

function render() {
  renderedDate = todayStr();
  if (!renderGate()) return;

  const tabs = allTabs();
  // Don't overwrite the saved tab: a just-added medicine may not be in the snapshot yet.
  const tab = tabs.find((t) => t.id === local.activeTab) ?? tabs[0];

  els.patientName.textContent = shared.patient.name;
  els.todayLabel.textContent = `ID ${shared.patient.code} · ` + new Date().toLocaleDateString([], {
    weekday: "short", month: "short", day: "numeric",
  });

  if (notesTabId) renderNotes(); // another nurse may have changed or removed it
  if (scheduleTabId) renderSchedule();

  const empty = !tab;
  els.empty.classList.toggle("hidden", !empty);
  els.tracker.classList.toggle("hidden", empty);
  els.tabs.classList.toggle("hidden", empty);
  els.daysLeftBtn.classList.toggle("hidden", empty);
  if (empty) return;

  renderTabs(tabs, tab.id);

  const left = daysLeft(tab.id);
  els.daysLeftNum.textContent = left ?? "–";
  els.daysLeftLabel.textContent = left == null ? "set days" : left === 1 ? "day left" : "days left";
  els.daysLeftBtn.classList.toggle("low", left != null && left <= 3);

  const named = tab.custom || tab.renamed;
  els.progressTitle.textContent = named ? tab.name : "Today's doses";
  els.progressSub.textContent = named ? scheduleText(tab.everyDays, tab.dosesPerDay) : "";
  els.progressSub.classList.toggle("hidden", !named);
  els.removeBtn.classList.toggle("hidden", !tab.custom);
  els.tabActions.classList.remove("hidden");
  els.notesBtn.classList.toggle("has-notes", !!tab.notes?.trim());

  const due = isDueToday(tab);
  const n = due ? tab.dosesPerDay : 0;
  const doses = Array.from({ length: n }, (_, i) => isTaken(tab.id, i));
  const doneCount = doses.filter(Boolean).length;
  els.progressCount.textContent = due ? `${doneCount} of ${n} taken` : "Not due today";
  els.progressFill.style.width = due ? `${(doneCount / n) * 100}%` : "0%";
  els.allDone.classList.toggle("hidden", !due || doneCount !== n);
  els.notDue.classList.toggle("hidden", due);
  if (!due) els.notDueText.textContent = `No doses today — next dose ${nextDueLabel(tab)}`;

  els.doseList.innerHTML = "";
  doses.forEach((taken, i) => {
    const key = `${tab.id}_${i}`;
    const reminder = shared.reminders?.[key];

    const li = document.createElement("li");
    li.className = "dose";

    const toggle = document.createElement("button");
    toggle.className = "dose-toggle" + (taken ? " taken" : "") + (justToggled === key ? " bump" : "");
    toggle.innerHTML = `
      <span class="dose-num">${taken ? "✓" : i + 1}</span>
      <span class="dose-text">
        <span class="dose-title">${ordinal(i + 1)} dose</span>
        <span class="dose-status">${taken ? "Taken" : "Not taken yet"}</span>
      </span>`;
    toggle.addEventListener("click", () => toggleDose(tab.id, i));

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

// ---------- Welcome (patient details) ----------
els.welcomeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = els.welcomeName.value.trim();
  const code = els.welcomeCode.value.trim();
  if (!name || !code) return;
  // An empty record is a brand-new patient: start without the old 1x/4x/6x tabs.
  // Older patients also land here once (to add details) but already have data, so they keep them.
  const fresh = Object.keys(shared ?? {}).length === 0;
  const data = fresh ? { patient: { name, code }, builtinTabs: false } : { patient: { name, code } };
  setDoc(patientRef, data, { merge: true }).catch(reportError);
});

// ---------- Steppers (− / + around a number input) ----------
function readNumber(input) {
  const v = parseInt(input.value, 10);
  return Number.isNaN(v) ? null : Math.min(Number(input.max), Math.max(Number(input.min), v));
}

document.querySelectorAll(".stepper").forEach((stepper) => {
  const input = stepper.querySelector("input");
  stepper.querySelectorAll("button[data-step]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const current = readNumber(input) ?? Number(input.min);
      input.value = current + Number(btn.dataset.step);
      input.value = readNumber(input);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })
  );
});

// ---------- Add / remove medicine ----------
// The add screen gets its own history entry, so the phone's back button closes it.
if (history.state?.addScreen) history.replaceState(null, "");

let addUnit = "days";

function setAddUnit(unit) {
  addUnit = unit;
  els.addUnit.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.unit === unit));
  els.addDuration.max = unit === "weeks" ? 52 : 365;
  if (els.addDuration.value) els.addDuration.value = readNumber(els.addDuration);
  updateAddSummary();
}

els.addUnit.querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => setAddUnit(b.dataset.unit))
);

function updateAddSummary() {
  const name = els.addName.value.trim() || "This medicine";
  const every = readNumber(els.addEvery) ?? 1;
  const doses = readNumber(els.addDoses) ?? 1;
  const duration = readNumber(els.addDuration) ?? 1;
  const length = plural(duration, addUnit === "weeks" ? "week" : "day");
  els.addSummary.textContent = `${name}: ${scheduleText(every, doses)} for ${length}, starting today.`;
}

function openAddScreen() {
  els.addForm.reset();
  setAddUnit("days");
  els.addScreen.classList.remove("hidden");
  history.pushState({ addScreen: true }, "");
  els.addName.focus();
}

function closeAddScreen() {
  if (history.state?.addScreen) history.back(); // popstate hides the screen
  else els.addScreen.classList.add("hidden");
}

window.addEventListener("popstate", () => els.addScreen.classList.add("hidden"));

els.addBtn.addEventListener("click", openAddScreen);
els.emptyAdd.addEventListener("click", openAddScreen);
els.addBack.addEventListener("click", closeAddScreen);
els.addForm.addEventListener("input", updateAddSummary);

els.addForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = els.addName.value.trim();
  const everyDays = readNumber(els.addEvery);
  const dosesPerDay = readNumber(els.addDoses);
  const duration = readNumber(els.addDuration);
  if (!name || !everyDays || !dosesPerDay || !duration) return;
  const totalDays = duration * (addUnit === "weeks" ? 7 : 1);
  const notes = els.addNotes.value.trim();
  const id = addMedicine({ name, everyDays, dosesPerDay, notes, totalDays });
  closeAddScreen();
  selectTab(id);
  showToast(`${name} added for all nurses.`);
});

els.removeBtn.addEventListener("click", () => {
  const tab = findTab(local.activeTab);
  if (!tab?.custom) return;
  if (!confirm(`Remove ${tab.name}? It will disappear for all nurses.`)) return;
  removeMedicine(tab.id);
  selectTab(allTabs().find((t) => t.id !== tab.id)?.id ?? "");
});

// Overlays fade out before hiding (see .closing in style.css).
function showOverlay(el) {
  clearTimeout(el.hideTimer);
  el.classList.remove("hidden", "closing");
  els.toast.classList.add("hidden"); // don't let a toast sit on top of the overlay
}

function hideOverlay(el) {
  if (el.classList.contains("hidden")) return;
  el.classList.add("closing");
  el.hideTimer = setTimeout(() => el.classList.add("hidden"), 180);
}

// ---------- Rename ----------
els.renameBtn.addEventListener("click", () => {
  const tab = findTab(local.activeTab);
  if (!tab) return;
  els.renameInput.value = tab.name;
  showOverlay(els.rename);
  els.renameInput.select();
});

els.renameForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const tab = findTab(local.activeTab);
  const name = els.renameInput.value.trim();
  if (!name) return;
  if (tab && name !== tab.name) updateTabField(tab, "name", name);
  render();
  hideOverlay(els.rename);
});

els.renameCancel.addEventListener("click", () => hideOverlay(els.rename));
els.rename.addEventListener("click", (e) => {
  if (e.target === els.rename) hideOverlay(els.rename);
});

// ---------- Notes ----------
let notesTabId = null; // tab whose notes are open
let notesEditing = false;

function renderNotes() {
  const tab = findTab(notesTabId);
  if (!tab) return closeNotes(true);
  const text = tab.notes?.trim() ?? "";
  els.notesTitle.textContent = tab.name;
  els.notesView.textContent = text;
  els.notesView.classList.toggle("empty", !text);
  els.notesView.classList.toggle("hidden", notesEditing);
  els.notesInput.classList.toggle("hidden", !notesEditing);
  els.notesDiscard.classList.toggle("hidden", !notesEditing);
  els.notesEdit.textContent = notesEditing ? "Save" : text ? "Edit" : "Add notes";
}

function openNotes() {
  notesTabId = local.activeTab;
  notesEditing = false;
  renderNotes();
  showOverlay(els.notes);
}

function closeNotes(force = false) {
  const saved = findTab(notesTabId)?.notes?.trim() ?? "";
  if (!force && notesEditing && els.notesInput.value.trim() !== saved
      && !confirm("Discard your changes to these notes?")) return;
  notesTabId = null;
  notesEditing = false;
  hideOverlay(els.notes);
}

els.notesBtn.addEventListener("click", openNotes);
els.notesClose.addEventListener("click", () => closeNotes());
els.notes.addEventListener("click", (e) => {
  if (e.target === els.notes) closeNotes();
});

els.notesEdit.addEventListener("click", () => {
  const tab = findTab(notesTabId);
  if (!tab) return;
  if (notesEditing) {
    const text = els.notesInput.value.trim();
    if (text !== (tab.notes?.trim() ?? "")) {
      updateTabField(tab, "notes", text);
    }
    notesEditing = false;
    renderNotes();
  } else {
    notesEditing = true;
    els.notesInput.value = tab.notes ?? "";
    renderNotes();
    els.notesInput.focus();
  }
});

els.notesDiscard.addEventListener("click", () => {
  notesEditing = false;
  renderNotes();
});

// ---------- Schedule (days left, frequency, dosage) ----------
let scheduleTabId = null; // tab whose schedule is open
let scheduleEditing = false;

function renderSchedule() {
  const tab = findTab(scheduleTabId);
  if (!tab) return closeSchedule(true);
  const left = daysLeft(tab.id);

  els.scheduleTitle.textContent = tab.name;
  els.statDays.textContent = left == null ? "Not set" : plural(left, "day");
  els.statDaysMeta.textContent = left == null ? "Tap Edit to set how long it's taken"
    : left === 0 ? "Course finished" : `Last day ${shortDate(left - 1)}`;
  els.statEvery.textContent = everyText(tab.everyDays).replace(/^e/, "E");
  els.statEveryMeta.textContent = isDueToday(tab) ? "Due today" : `Next dose ${nextDueLabel(tab)}`;
  els.statDoses.textContent = `${plural(tab.dosesPerDay, "dose")} a day`;
  els.statDosesMeta.textContent = tab.custom ? "On each dose day" : `Fixed for the ${tab.name} tab`;

  els.scheduleView.classList.toggle("hidden", scheduleEditing);
  els.scheduleEdit.classList.toggle("hidden", !scheduleEditing);
  els.schedCustom.classList.toggle("hidden", !tab.custom);
  els.schedFixed.classList.toggle("hidden", !!tab.custom);
  els.scheduleDiscard.classList.toggle("hidden", !scheduleEditing);
  els.scheduleEditBtn.textContent = scheduleEditing ? "Save" : "Edit";
}

function scheduleChanges(tab) {
  const fields = [];
  const days = readNumber(els.schedDays);
  if (days != null && days !== daysLeft(tab.id)) {
    fields.push(new FieldPath("courses", tab.id), { startDays: days, startDate: todayStr() });
  }
  if (tab.custom) {
    const every = readNumber(els.schedEvery);
    if (every && every !== tab.everyDays) {
      // Restart the cycle today so the new frequency's first dose is today.
      fields.push(new FieldPath("medicines", tab.id, "everyDays"), every,
                  new FieldPath("medicines", tab.id, "startDate"), todayStr());
    }
    const doses = readNumber(els.schedDoses);
    if (doses && doses !== tab.dosesPerDay) {
      fields.push(new FieldPath("medicines", tab.id, "dosesPerDay"), doses, ...reminderDeletes(tab.id, doses));
    }
  }
  return fields;
}

function openSchedule() {
  scheduleTabId = local.activeTab;
  scheduleEditing = false;
  renderSchedule();
  showOverlay(els.schedule);
}

function closeSchedule(force = false) {
  const tab = findTab(scheduleTabId);
  if (!force && scheduleEditing && tab && scheduleChanges(tab).length
      && !confirm("Discard your changes to this schedule?")) return;
  scheduleTabId = null;
  scheduleEditing = false;
  hideOverlay(els.schedule);
}

els.scheduleBtn.addEventListener("click", openSchedule);
els.daysLeftBtn.addEventListener("click", openSchedule);
els.scheduleClose.addEventListener("click", () => closeSchedule());
els.schedule.addEventListener("click", (e) => {
  if (e.target === els.schedule) closeSchedule();
});

els.scheduleEditBtn.addEventListener("click", () => {
  const tab = findTab(scheduleTabId);
  if (!tab) return;
  if (scheduleEditing) {
    const fields = scheduleChanges(tab);
    if (fields.length) updateDoc(patientRef, ...fields).catch(reportError);
    scheduleEditing = false;
    renderSchedule();
  } else {
    scheduleEditing = true;
    els.schedDays.value = daysLeft(tab.id) ?? "";
    els.schedEvery.value = tab.everyDays;
    els.schedDoses.value = tab.dosesPerDay;
    renderSchedule();
  }
});

els.scheduleDiscard.addEventListener("click", () => {
  scheduleEditing = false;
  renderSchedule();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!els.rename.classList.contains("hidden")) hideOverlay(els.rename);
  else if (notesTabId) closeNotes();
  else if (scheduleTabId) closeSchedule();
});

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
  if (!hasPatientDetails()) return;
  const now = new Date();
  const today = todayStr(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const [key, time] of Object.entries(shared.reminders ?? {})) {
    if (local.notified[key] === today) continue;
    const [h, m] = time.split(":").map(Number);
    if (nowMinutes < h * 60 + m) continue;

    const [tabId, i] = key.split("_");
    const tab = findTab(tabId);
    if (!tab || !isDueToday(tab)) continue;
    local.notified[key] = today;
    saveLocal();
    // Skip the alert if any nurse already marked the dose taken.
    if (isTaken(tabId, Number(i))) continue;
    notify("Time for medicine 💊", `${ordinal(Number(i) + 1)} dose of ${tab.label}`);
  }
}

// ---------- Init ----------
window.appStarted = true; // tells the reload-on-crash guard in index.html that startup worked
render();

onSnapshot(
  patientRef,
  (snap) => {
    shared = snap.data() ?? {};
    render();
    checkReminders();
  },
  (err) => {
    console.error(err);
    els.bootText.textContent = "Not connected";
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
