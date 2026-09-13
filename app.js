import {
  DEFAULT_SETTINGS,
  addMonths,
  calculatePaymentAmount,
  calculateShift,
  calculateSummary,
  formatDecimalHours,
  formatHoursMinutes,
  formatMoney,
  getPayPeriodDates,
  getPayPeriodStart,
  isDateInPeriod,
  parseISODate,
  roundHoursUpToTenMinutes,
  toISODate
} from "./calculator.js";
import { mergeSchedule } from "./schedule-merge.js";

const STORAGE_KEY = "bilka-pay-app-v1";
const PERIOD_STORAGE_KEY = "bilka-pay-period-start";
const THEME_STORAGE_KEY = "bilka-pay-theme";
const DEFAULT_PAYMENT_CATEGORIES = ["Fast", "Mad", "Transport", "Andet"];
const SYNC_POLL_MS = 30_000;
const SCHEDULE_POLL_MS = 60 * 60_000;
const monthFormatter = new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "long", year: "numeric" });
const shortDateFormatter = new Intl.DateTimeFormat("da-DK", { day: "2-digit", month: "2-digit", year: "numeric" });

const seededShifts = {
  "2026-04-25": { time: "20:00-22:10", pauseOverride: 0 },
  "2026-04-28": { time: "18:50-22:00", pauseOverride: 0 },
  "2026-05-01": { time: "16:00-18:30", pauseOverride: 0 },
  "2026-05-02": { time: "10:55-22:00", pauseOverride: 75 },
  "2026-05-03": { time: "18:50-22:00", pauseOverride: 0 },
  "2026-05-08": { time: "15:50-18:05", pauseOverride: 0 },
  "2026-05-13": { time: "14:45-20:15", pauseOverride: 30 },
  "2026-05-15": { time: "12:00-18:05", pauseOverride: null },
  "2026-05-16": { time: "10:30-18:30", pauseOverride: null },
  "2026-05-17": { time: "10:30-14:33", pauseOverride: 0 }
};

function initialState() {
  return {
    version: 5,
    updatedAt: new Date().toISOString(),
    periodStart: "2026-04-19",
    shifts: seededShifts,
    payments: [],
    customPaymentCategories: [],
    manualFerie: 0,
    manualFritvalg: 0,
    includeFerie: true,
    includeFritvalg: true,
    goalTarget: 10000,
    settings: structuredClone(DEFAULT_SETTINGS)
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || typeof saved !== "object") return initialState();
    return normalizeState(saved, { periodStart: localStorage.getItem(PERIOD_STORAGE_KEY) || saved.periodStart });
  } catch {
    return initialState();
  }
}

function isValidPeriodStart(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const date = parseISODate(value);
  return !Number.isNaN(date.getTime()) && date.getDate() === 19;
}

function normalizeState(saved, options = {}) {
  const shouldUpdateRates = !saved.version || saved.version < 3;
  const periodStart = isValidPeriodStart(options.periodStart)
    ? options.periodStart
    : isValidPeriodStart(saved.periodStart)
      ? saved.periodStart
      : initialState().periodStart;
  return {
    ...initialState(),
    ...saved,
    version: 5,
    periodStart,
    updatedAt: saved.updatedAt || new Date(0).toISOString(),
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      ...(saved.settings || {}),
      rates: shouldUpdateRates
        ? structuredClone(DEFAULT_SETTINGS.rates)
        : saved.settings?.rates || structuredClone(DEFAULT_SETTINGS.rates)
    }
  };
}

let state = loadState();
let activeTab = "dashboard";
let toastTimer;
let paymentModal = null;
let editingShiftDate = null;
let currentUser = null;
let scheduleSource = null;
let discordSource = null;
let syncStatus = "loading";
let syncTimer;

const views = Object.fromEntries([...document.querySelectorAll(".view")].map((view) => [view.id, view]));

function storedTheme() {
  return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
}

function applyTheme(theme, { persist = true } = {}) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", nextTheme === "dark" ? "#061a2b" : "#00a3d9");
  if (persist) localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  updateThemeToggle(nextTheme);
}

function updateThemeToggle(theme = storedTheme()) {
  const button = document.querySelector("#theme-toggle");
  const icon = document.querySelector("#theme-icon");
  const label = document.querySelector("#theme-label");
  if (!button || !icon || !label) return;
  const isDark = theme === "dark";
  icon.textContent = isDark ? "☀" : "☾";
  label.textContent = isDark ? "Lys" : "Mørk";
  button.setAttribute("aria-label", isDark ? "Skift til lys tilstand" : "Skift til mørk tilstand");
  button.title = isDark ? "Skift til lys tilstand" : "Skift til mørk tilstand";
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  if (activeTab === "dashboard") drawPayChart(calculateSummary(state));
}

function saveState({ sync = true } = {}) {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(PERIOD_STORAGE_KEY, state.periodStart);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (sync) queueSyncSave();
  updateSyncIndicator();
}

function savePeriodView() {
  localStorage.setItem(PERIOD_STORAGE_KEY, state.periodStart);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  updateSyncIndicator();
}

function syncState() {
  const { periodStart, ...planState } = state;
  return planState;
}

function queueSyncSave() {
  clearTimeout(syncTimer);
  syncStatus = "saving";
  updateSyncIndicator();
  syncTimer = setTimeout(() => pushSyncPlan(), 700);
}

// A 401 means the session expired while the tab was open; go back to login
// rather than silently dropping the user's edits into "offline".
function handleSignedOut(response) {
  if (response.status !== 401) return false;
  window.location.replace("/login");
  return true;
}

async function pushSyncPlan() {
  try {
    const response = await fetch("/api/plan", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: syncState() })
    });
    if (handleSignedOut(response)) return;
    if (!response.ok) throw new Error("Sync save failed");
    const result = await response.json();
    if (result.conflict && result.state) {
      state = normalizeState(result.state, { periodStart: state.periodStart });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      renderAll();
    }
    syncStatus = "synced";
  } catch {
    syncStatus = "offline";
  }
  updateSyncIndicator();
}

// Re-rendering swaps out the DOM, so pulling a remote plan mid-edit would throw
// away whatever is half-typed. Defer until the user is idle again.
function isUserBusy() {
  if (paymentModal || editingShiftDate) return true;
  const active = document.activeElement;
  return Boolean(active && active.matches?.("input, select, textarea"));
}

// Whichever side has the newer updatedAt wins, so this doubles as the boot
// load, the background poll and the catch-up after being offline.
async function reconcileSyncPlan({ silent = false } = {}) {
  if (!silent) {
    syncStatus = "loading";
    updateSyncIndicator();
  }
  try {
    const response = await fetch("/api/plan", { cache: "no-store" });
    if (handleSignedOut(response)) return;
    if (response.status === 404) {
      // First login on this account: upload whatever this device already has.
      await pushSyncPlan();
      return;
    }
    if (!response.ok) throw new Error("Sync load failed");
    const remote = await response.json();
    const remoteState = normalizeState(remote.state || {}, { periodStart: state.periodStart });
    const remoteTime = new Date(remoteState.updatedAt).getTime();
    const localTime = new Date(state.updatedAt).getTime();

    if (remoteTime > localTime) {
      // The user may have started typing while the request was in flight.
      if (silent && isUserBusy()) return;
      state = remoteState;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      renderAll();
      if (silent) showToast("Planen er opdateret fra en anden enhed.");
    } else if (localTime > remoteTime) {
      await pushSyncPlan();
      return;
    }
    syncStatus = "synced";
  } catch {
    syncStatus = "offline";
  }
  updateSyncIndicator();
}

function mergeScheduleShifts(imported, range) {
  const result = mergeSchedule(state.shifts || {}, imported, range);
  if (result.changed) {
    state.shifts = result.shifts;
    saveState();
    renderAll();
  }
  return {
    added: result.added.length,
    updated: result.updated.length,
    removed: result.removed.length,
    changed: result.changed
  };
}

function scheduleStatusText() {
  if (!scheduleSource) return "Henter status…";
  return scheduleSource.configured
    ? `Forbundet til ${escapeHTML(scheduleSource.host || "UKG")}. Adressen vises ikke igen.`
    : "Ingen kalender gemt endnu.";
}

async function loadScheduleStatus() {
  try {
    const response = await fetch("/api/schedule", { cache: "no-store" });
    if (handleSignedOut(response)) return;
    if (response.ok) scheduleSource = await response.json();
  } catch {
    scheduleSource = { configured: false };
  }
}

async function saveScheduleUrl() {
  const input = document.querySelector("#schedule-url");
  const status = document.querySelector("#schedule-status");
  const url = input.value.trim();
  status.textContent = "Gemmer…";

  try {
    const response = await fetch("/api/schedule", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    if (handleSignedOut(response)) return;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      status.textContent = payload.error || "Kunne ikke gemme adressen.";
      return;
    }
    scheduleSource = payload;
    // Clear it from the field so it is not left on screen or in the DOM.
    input.value = "";
    status.textContent = scheduleStatusText();
    if (payload.configured) await importSchedule();
  } catch {
    status.textContent = "Ingen forbindelse til serveren.";
  }
}

function discordStatusText() {
  if (!discordSource) return "Henter status…";
  return discordSource.configured
    ? "Forbundet. Webhook-adressen vises ikke igen."
    : "Ingen webhook gemt endnu.";
}

async function loadDiscordStatus() {
  try {
    const response = await fetch("/api/discord", { cache: "no-store" });
    if (handleSignedOut(response)) return;
    if (response.ok) discordSource = await response.json();
  } catch {
    discordSource = { configured: false };
  }
}

async function saveDiscordWebhook() {
  const input = document.querySelector("#discord-url");
  const status = document.querySelector("#discord-status");
  status.textContent = "Gemmer…";

  try {
    const response = await fetch("/api/discord", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: input.value.trim() })
    });
    if (handleSignedOut(response)) return;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      status.textContent = payload.error || "Kunne ikke gemme webhooken.";
      return;
    }
    discordSource = payload;
    input.value = "";
    status.textContent = discordStatusText();
  } catch {
    status.textContent = "Ingen forbindelse til serveren.";
  }
}

async function testDiscordWebhook() {
  const status = document.querySelector("#discord-status");
  status.textContent = "Sender test…";
  try {
    const response = await fetch("/api/discord", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    if (handleSignedOut(response)) return;
    const payload = await response.json().catch(() => ({}));
    status.textContent = response.ok
      ? "Testbesked sendt — kig i Discord."
      : (payload.error || "Kunne ikke sende testbesked.");
  } catch {
    status.textContent = "Ingen forbindelse til serveren.";
  }
}

async function createDiscordLinkCode() {
  const status = document.querySelector("#discord-status");
  status.textContent = "Laver kode…";
  try {
    const response = await fetch("/api/discord/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    if (handleSignedOut(response)) return;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      status.textContent = payload.error || "Kunne ikke lave en kode.";
      return;
    }
    status.innerHTML = `Skriv i Discord: <code>/sync kode:${escapeHTML(payload.code)}</code>`
      + ` — gælder i ${payload.expiresInMinutes} minutter.`;
  } catch {
    status.textContent = "Ingen forbindelse til serveren.";
  }
}

async function importSchedule({ silent = false } = {}) {
  try {
    const response = await fetch("/api/schedule/shifts", { cache: "no-store" });
    if (handleSignedOut(response)) return null;
    if (response.status === 404) return null;
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (!silent) showToast(payload.error || "Kunne ikke hente vagtplanen.");
      return null;
    }
    const result = await response.json();
    const summary = mergeScheduleShifts(result.shifts || {}, result);

    if (!silent || summary.changed) {
      const parts = [];
      if (summary.added) parts.push(`${summary.added} nye`);
      if (summary.updated) parts.push(`${summary.updated} ændrede`);
      if (summary.removed) parts.push(`${summary.removed} fjernede`);
      showToast(parts.length ? `Vagtplan: ${parts.join(", ")}.` : "Vagtplanen er allerede opdateret.");
    }
    return summary;
  } catch {
    if (!silent) showToast("Kunne ikke hente vagtplanen.");
    return null;
  }
}

function startAutoSync() {
  // Only while the tab is actually on screen, so a phone in a pocket is not
  // polling every 30s on mobile data.
  setInterval(() => {
    if (document.visibilityState !== "visible" || isUserBusy()) return;
    reconcileSyncPlan({ silent: true });
  }, SYNC_POLL_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reconcileSyncPlan({ silent: true });
  });
  window.addEventListener("focus", () => reconcileSyncPlan({ silent: true }));
  // Coming back from a dead connection should not wait for the next tick.
  window.addEventListener("online", () => reconcileSyncPlan({ silent: true }));

  // Rosters change on the order of days, so hourly is plenty and keeps the
  // number of calls out to UKG small.
  setInterval(() => {
    if (document.visibilityState !== "visible" || isUserBusy()) return;
    importSchedule({ silent: true });
  }, SCHEDULE_POLL_MS);
}

function updateSyncIndicator() {
  const dot = document.querySelector("#sync-dot");
  const label = document.querySelector("#sync-label");
  if (!dot || !label) return;
  dot.dataset.status = syncStatus;
  label.textContent = {
    loading: "Henter plan...",
    saving: "Gemmer...",
    synced: currentUser ? `Gemt som ${currentUser.username}` : "Plan synkroniseret",
    offline: "Gemmer lokalt"
  }[syncStatus] || "Henter plan...";
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function numberValue(value) {
  const normalized = String(value ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function inputNumber(value) {
  return Number(value || 0).toFixed(2);
}

function paymentCategories() {
  return [...new Set([...DEFAULT_PAYMENT_CATEGORIES, ...(state.customPaymentCategories || [])])];
}

function paymentCategoryOptions(selected) {
  return paymentCategories().map((category) => option(category, selected)).join("");
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

async function signOut() {
  try {
    await fetch("/api/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
  } catch {
    // Even if the request fails, clear the device copy and let the server
    // redirect decide — the plan is safely on the server.
  }
  localStorage.removeItem(STORAGE_KEY);
  window.location.replace("/login");
}

function periodText() {
  const start = parseISODate(state.periodStart);
  const end = addMonths(start, 1);
  end.setDate(end.getDate() - 1);
  const startText = monthFormatter.format(start);
  const endText = monthFormatter.format(end);
  return `${startText} - ${endText}`;
}

function heading(title, subtitle, action = "") {
  return `
    <div class="page-heading">
      <div>
        <h1>${title}</h1>
        <p>${subtitle}</p>
      </div>
      ${action}
    </div>
  `;
}

function renderPeriod() {
  const summary = calculateSummary(state);
  const shiftCount = summary.shiftRows.filter((row) => row.paidHours > 0).length;
  document.querySelector("#period-label").textContent = periodText();
  document.querySelector("#shell-shifts").textContent = shiftCount;
  document.querySelector("#shell-pay").textContent = formatMoney(summary.totalGross);
  document.querySelector("#shell-left").textContent = formatMoney(summary.paymentLeft);
}

function renderAll() {
  renderPeriod();
  renderDashboard();
  renderTimeLog();
  renderPayments();
  renderExtras();
  renderSettings();
  activateTab(activeTab);
}

function renderDashboard() {
  const summary = calculateSummary(state);
  views.dashboard.innerHTML = `
    ${heading("Dashboard", periodText())}
    <div class="kpi-grid">
      <article class="kpi primary">
        <span class="kpi-label">Tilbage efter betalinger</span>
        <strong class="kpi-value">${formatMoney(summary.paymentLeft)}</strong>
        <span class="kpi-note">Med valgte ferie- og fritvalgspuljer</span>
      </article>
      <article class="kpi">
        <span class="kpi-label">Samlet løn</span>
        <strong class="kpi-value">${formatMoney(summary.totalGross)}</strong>
        <span class="kpi-note">Efter 8% + 8% på ferie/fritvalg</span>
      </article>
      <article class="kpi">
        <span class="kpi-label">Betalte timer</span>
        <strong class="kpi-value">${formatHoursMinutes(summary.paidHours)}</strong>
        <span class="kpi-note">${formatDecimalHours(summary.paidHours)} timer i perioden</span>
      </article>
      <article class="kpi">
        <span class="kpi-label">Betalinger</span>
        <strong class="kpi-value">${formatMoney(summary.paymentsTotal)}</strong>
        <span class="kpi-note">Kun betalinger der ikke er sprunget over</span>
      </article>
    </div>

    <div class="dashboard-grid">
      <div class="stack">
        <article class="panel">
          <div class="panel-heading navy"><h2>Lønoversigt</h2></div>
          <div class="panel-body">
            <dl class="metric-list">
              <div class="metric-row"><dt>Grundløn</dt><dd>${formatMoney(summary.basePay)}</dd></div>
              <div class="metric-row"><dt>Ferie</dt><dd>${formatMoney(summary.ferieGross)}</dd></div>
              <div class="metric-row"><dt>Fritvalg</dt><dd>${formatMoney(summary.fritvalgGross)}</dd></div>
              <div class="metric-row negative"><dt>Bruttoferiekort -8%</dt><dd>-${formatMoney(summary.bruttoDeduction)}</dd></div>
              <div class="metric-row negative"><dt>Arbejdsmarkedsbidrag -8%</dt><dd>-${formatMoney(summary.amDeduction)}</dd></div>
              <div class="metric-row total"><dt>Samlet løn</dt><dd>${formatMoney(summary.totalGross)}</dd></div>
            </dl>
          </div>
        </article>

        <article class="panel">
          <div class="panel-heading"><h2>Timer</h2></div>
          <div class="panel-body">
            <dl class="metric-list">
              <div class="metric-row"><dt>Timer i alt</dt><dd>${formatDecimalHours(summary.paidHours)}</dd></div>
            </dl>
          </div>
        </article>

        <article class="panel">
          <div class="panel-heading green"><h2>Mål</h2><small>Grundløn ${formatMoney(state.settings.baseWage)} / time</small></div>
          <div class="panel-body goal-grid">
            <label class="field">
              <span>Målbeløb</span>
              <input id="goal-target" type="number" min="0" step="50" value="${state.goalTarget}">
            </label>
            <div class="field">
              <span>Timer nødvendige</span>
              <div class="output-box">${formatHoursMinutes(summary.goalHoursNeeded)}</div>
            </div>
            <div class="field">
              <span>Timer tilbage</span>
              <div class="output-box">${formatHoursMinutes(summary.goalHoursLeft)}</div>
            </div>
          </div>
        </article>
      </div>

      <article class="panel">
        <div class="panel-heading"><h2>Løn og betalinger</h2><small>Hvor meget er brugt og tilbage</small></div>
        <div class="chart-wrap">
          <canvas id="pay-chart" width="560" height="380" aria-label="Cirkeldiagram over løn og betalinger"></canvas>
          <div class="chart-legend">
            ${legend("#00a3d9", "Tilbage", summary.paymentLeft)}
            ${legend("#173d68", "Betalinger", summary.paymentsTotal)}
          </div>
        </div>
      </article>
    </div>
  `;

  document.querySelector("#goal-target").addEventListener("change", (event) => {
    state.goalTarget = Math.max(0, numberValue(event.target.value));
    saveState();
    renderDashboard();
  });
  drawPayChart(summary);
}

function legend(color, label, value) {
  return `
    <div class="legend-item">
      <span class="legend-swatch" style="background:${color}"></span>
      <div><strong>${label}</strong><span>${formatMoney(value)}</span></div>
    </div>
  `;
}

function drawPayChart(summary) {
  const canvas = document.querySelector("#pay-chart");
  if (!canvas) return;
  const context = canvas.getContext("2d");
  const isDark = document.documentElement.dataset.theme === "dark";
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const cssWidth = Math.max(250, Math.floor(rect.width));
  const cssHeight = Math.min(300, Math.max(230, Math.floor(cssWidth * 0.68)));
  canvas.width = cssWidth * scale;
  canvas.height = cssHeight * scale;
  canvas.style.height = `${cssHeight}px`;
  context.scale(scale, scale);

  const paymentSlice = Math.min(Math.max(summary.paymentsTotal, 0), Math.max(summary.paymentBasis, 0));
  const data = [
    { value: Math.max(summary.paymentBasis - paymentSlice, 0), color: "#00a3d9" },
    { value: paymentSlice, color: "#173d68" }
  ];
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const centerX = cssWidth / 2;
  const centerY = cssHeight / 2;
  const radius = Math.min(cssWidth, cssHeight) * 0.39;
  const innerRadius = radius * 0.59;

  context.clearRect(0, 0, cssWidth, cssHeight);
  if (total <= 0) {
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.strokeStyle = isDark ? "#24445d" : "#dce6ed";
    context.lineWidth = radius - innerRadius;
    context.stroke();
  } else {
    let angle = -Math.PI / 2;
    for (const item of data) {
      if (item.value <= 0) continue;
      const nextAngle = angle + (item.value / total) * Math.PI * 2;
      context.beginPath();
      context.arc(centerX, centerY, radius, angle, nextAngle);
      context.arc(centerX, centerY, innerRadius, nextAngle, angle, true);
      context.closePath();
      context.fillStyle = item.color;
      context.fill();
      angle = nextAngle;
    }
  }

  context.fillStyle = isDark ? "#e9f8ff" : "#172a3a";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `800 ${Math.max(18, Math.min(27, cssWidth / 16))}px Inter, sans-serif`;
  context.fillText(formatMoney(summary.paymentBasis), centerX, centerY - 7);
  context.fillStyle = isDark ? "#9eb8cd" : "#637586";
  context.font = "600 12px Inter, sans-serif";
  context.fillText("før betalinger", centerX, centerY + 18);
}

function renderTimeLog() {
  const summary = calculateSummary(state);
  const activeRows = summary.shiftRows.filter((row) => state.shifts[row.date]?.time);
  const formDate = editingShiftDate || state.periodStart;
  const formEntry = state.shifts[formDate] || {};
  const [formStart = "12:00", formEnd = "22:00"] = String(formEntry.time || "12:00-22:00").split("-");
  const shiftCards = activeRows.map((row) => {
    const entry = state.shifts[row.date] || {};
    return `
      <article class="shift-item">
        <div class="shift-date">
          <strong>${new Intl.DateTimeFormat("da-DK", { weekday: "short", day: "numeric", month: "short" }).format(parseISODate(row.date))}</strong>
          <span>${shortDateFormatter.format(parseISODate(row.date))}</span>
        </div>
        <div class="shift-main">
          <strong>${escapeHTML(entry.time)}</strong>
          <span>${formatHoursMinutes(row.paidHours)} betalt · ${row.pauseMinutes} min pause</span>
          ${entry.note ? `<small>${escapeHTML(entry.note)}</small>` : ""}
        </div>
        <div class="shift-pay">
          <strong>${formatMoney(row.totalPay)}</strong>
          ${row.holidayName ? `<span class="holiday-badge">${row.holidayName}</span>` : ""}
        </div>
        <div class="shift-actions">
          <button type="button" data-edit-shift="${row.date}">Rediger</button>
          <button class="shift-delete" type="button" data-delete-shift="${row.date}" aria-label="Slet vagt ${row.date}">×</button>
        </div>
      </article>
    `;
  }).join("");

  views["time-log"].innerHTML = `
    <div class="shift-layout">
      <section class="shift-form-card">
        <div class="section-title">
          <span>+</span>
          <div>
            <h1>${editingShiftDate ? "Rediger vagt" : "Tilføj vagt"}</h1>
            <p>${periodText()}</p>
          </div>
        </div>
        <form id="shift-form" class="shift-form">
          <label class="field modal-wide">
            <span>Dato</span>
            <input id="shift-date" type="date" value="${formDate}" required>
          </label>
          <div class="shift-time-fields">
            <label class="field">
              <span>Start</span>
              <input id="shift-start" type="time" value="${formStart}" required>
            </label>
            <label class="field">
              <span>Slut</span>
              <input id="shift-end" type="time" value="${formEnd}" required>
            </label>
          </div>
          <label class="field">
            <span>Note (valgfri)</span>
            <input id="shift-note" value="${escapeHTML(formEntry.note || "")}" placeholder="Fx Kasse, Frugt & Grønt">
          </label>
          <label class="field">
            <span>Pause override i minutter (valgfri)</span>
            <input id="shift-pause" type="number" min="0" step="5" value="${formEntry.pauseOverride ?? ""}" placeholder="Automatisk">
          </label>
          <button class="primary-button shift-submit" type="submit">${editingShiftDate ? "Gem ændringer" : "Tilføj vagt"}</button>
          ${editingShiftDate ? '<button id="cancel-shift-edit" class="shift-cancel" type="button">Annuller redigering</button>' : ""}
          <small class="shift-break-note">Pausen beregnes automatisk: over 4:31 = 30 min, fra 6:00 = 30 min og fra 10:00 = 75 min.</small>
        </form>
      </section>

      <section class="shift-list-card">
        <div class="shift-list-heading">
          <div>
            <h2>Vagter i perioden</h2>
            <span>${activeRows.length} ${activeRows.length === 1 ? "vagt" : "vagter"}</span>
          </div>
          <strong>${formatMoney(summary.eligiblePay)}</strong>
        </div>
        <div class="shift-list">
          ${shiftCards || `
            <div class="shift-empty">
              <strong>Ingen vagter i denne periode</strong>
              <span>Tilføj din første vagt i formularen.</span>
            </div>
          `}
        </div>
      </section>
    </div>
  `;

  document.querySelector("#shift-form").addEventListener("submit", saveShiftFromForm);
  document.querySelector("#cancel-shift-edit")?.addEventListener("click", () => {
    editingShiftDate = null;
    renderTimeLog();
  });
  views["time-log"].querySelectorAll("[data-edit-shift]").forEach((button) => {
    button.addEventListener("click", () => {
      editingShiftDate = button.dataset.editShift;
      renderTimeLog();
    });
  });
  views["time-log"].querySelectorAll("[data-delete-shift]").forEach((button) => {
    button.addEventListener("click", () => {
      delete state.shifts[button.dataset.deleteShift];
      if (editingShiftDate === button.dataset.deleteShift) editingShiftDate = null;
      saveState();
      renderAll();
    });
  });
}

function saveShiftFromForm(event) {
  event.preventDefault();
  const date = document.querySelector("#shift-date").value;
  if (!isDateInPeriod(date, state.periodStart)) {
    showToast("Datoen skal være i den valgte lønperiode.");
    return;
  }
  const start = document.querySelector("#shift-start").value;
  const end = document.querySelector("#shift-end").value;
  const pauseText = document.querySelector("#shift-pause").value;
  if (editingShiftDate && editingShiftDate !== date) delete state.shifts[editingShiftDate];
  state.shifts[date] = {
    time: `${start}-${end}`,
    pauseOverride: pauseText === "" ? null : Math.max(0, numberValue(pauseText)),
    note: document.querySelector("#shift-note").value.trim()
  };
  editingShiftDate = null;
  saveState();
  renderAll();
  showToast("Vagten er gemt.");
}

function renderPayments() {
  const summary = calculateSummary(state);
  const periodPayments = state.payments.filter((payment) => isDateInPeriod(payment.date, state.periodStart));
  const rows = periodPayments.map((payment) => {
    const mode = payment.mode || "fixed";
    const calculatedAmount = calculatePaymentAmount({ ...payment, mode }, summary.paymentBasis);
    const hours = roundHoursUpToTenMinutes(calculatedAmount / Number(state.settings.baseWage));
    return `
      <tr class="payment-row status-${payment.status}" data-payment-id="${payment.id}">
        <td><input class="table-input" type="date" data-payment-field="date" value="${escapeHTML(payment.date)}"></td>
        <td><input class="table-input" data-payment-field="bill" value="${escapeHTML(payment.bill)}" placeholder="Fx telefon"></td>
        <td>
          <select class="table-input" data-payment-field="category">
            ${paymentCategoryOptions(payment.category)}
          </select>
        </td>
        <td>
          <select class="table-input" data-payment-field="status">
            ${option("planned", payment.status, "Planlagt")}
            ${option("paid", payment.status, "Betalt")}
            ${option("skipped", payment.status, "Sprunget over")}
          </select>
        </td>
        <td>
          <select class="table-input payment-mode" data-payment-field="mode">
            ${option("fixed", mode, "Fast beløb")}
            ${option("percent", mode, "% af løn")}
          </select>
        </td>
        <td><input class="table-input" type="number" min="0" step="0.01" data-payment-field="amount"
          value="${payment.amount || ""}" placeholder="${mode === "percent" ? "10" : "0,00"}"></td>
        <td class="money-cell">${formatMoney(calculatedAmount)}</td>
        <td>${formatHoursMinutes(hours)}</td>
        <td><input class="table-input" data-payment-field="notes" value="${escapeHTML(payment.notes)}" placeholder="Valgfrit"></td>
        <td><button class="remove-row" type="button" title="Slet betaling" aria-label="Slet betaling">×</button></td>
      </tr>
    `;
  }).join("");

  views.payments.innerHTML = `
    ${heading(
      "Betalinger",
      `Betalinger i ${periodText()}`,
      '<button id="add-payment" class="primary-button" type="button">Tilføj betaling</button>'
    )}
    <div class="payments-overview">
      <article class="payment-balance">
        <span>Tilbage efter betalinger</span>
        <strong>${formatMoney(summary.paymentLeft)}</strong>
        <small>Fra ${formatMoney(summary.paymentBasis)} før betalinger</small>
      </article>
      <article class="payment-stat">
        <span>Betalinger i alt</span>
        <strong>${formatMoney(summary.paymentsTotal)}</strong>
        <small>Sprunget over tæller ikke med</small>
      </article>
      <article class="payment-stat">
        <span>Timer arbejdet for det</span>
        <strong>${formatHoursMinutes(roundHoursUpToTenMinutes(summary.paymentsTotal / state.settings.baseWage))}</strong>
        <small>Beregnet med ${formatMoney(state.settings.baseWage)} / time</small>
      </article>
    </div>
    <div class="table-shell payments-shell">
      <div class="payments-list-heading">
        <div>
          <h2>Betalingsliste</h2>
          <span>${periodPayments.length} ${periodPayments.length === 1 ? "betaling" : "betalinger"} i perioden</span>
        </div>
      </div>
      <div class="table-scroll">
        <table class="payments-table">
          <thead>
            <tr>
              <th>Dato</th>
              <th>Betaling</th>
              <th>Kategori</th>
              <th>Status</th>
              <th>Beregning</th>
              <th>Beløb / %</th>
              <th>Beregnet</th>
              <th>Timer for det</th>
              <th>Noter</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="10" class="empty-state">Ingen betalinger i denne periode endnu.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.querySelector("#add-payment").addEventListener("click", openPaymentModal);
  views.payments.querySelectorAll("[data-payment-field]").forEach((input) => {
    input.addEventListener(input.tagName === "SELECT" ? "change" : "blur", handlePaymentChange);
  });
  views.payments.querySelectorAll(".remove-row").forEach((button) => {
    button.addEventListener("click", removePayment);
  });
}

function option(value, selected, label = value) {
  return `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`;
}

function createId() {
  return globalThis.crypto?.randomUUID?.() || `payment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function openPaymentModal() {
  paymentModal = {
    mode: "fixed",
    date: state.periodStart,
    bill: "",
    category: "Fast",
    status: "planned",
    amount: "",
    notes: "",
    categoryManagerOpen: false
  };
  renderPaymentModal();
}

function closePaymentModal() {
  paymentModal = null;
  document.body.classList.remove("modal-open");
  document.querySelector("#modal-root").innerHTML = "";
  document.querySelector("#add-payment")?.focus();
}

function renderPaymentModal() {
  const root = document.querySelector("#modal-root");
  if (!paymentModal) {
    root.innerHTML = "";
    document.body.classList.remove("modal-open");
    return;
  }

  document.body.classList.add("modal-open");
  root.innerHTML = paymentDetailsModal();
  root.querySelector(".modal-backdrop").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closePaymentModal();
  });
  root.querySelector(".modal-close").addEventListener("click", closePaymentModal);
  root.querySelector("[data-modal-action='cancel']").addEventListener("click", closePaymentModal);
  root.querySelectorAll("[data-payment-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      readPaymentModalFields();
      paymentModal.mode = button.dataset.paymentMode;
      renderPaymentModal();
    });
  });
  root.querySelector("#toggle-category-manager").addEventListener("click", () => {
    readPaymentModalFields();
    paymentModal.categoryManagerOpen = !paymentModal.categoryManagerOpen;
    renderPaymentModal();
  });
  root.querySelector("#add-category-button")?.addEventListener("click", addPaymentCategory);
  root.querySelector("#new-category-name")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addPaymentCategory();
    }
  });
  root.querySelectorAll("[data-delete-category]").forEach((button) => {
    button.addEventListener("click", () => deletePaymentCategory(button.dataset.deleteCategory));
  });
  root.querySelector("#payment-modal-form").addEventListener("submit", savePaymentFromModal);
  root.querySelectorAll("[data-modal-field]").forEach((input) => {
    input.addEventListener("input", updatePaymentModalPreview);
    input.addEventListener("change", updatePaymentModalPreview);
  });
  root.querySelector("#payment-name")?.focus();
}

function paymentDetailsModal() {
  const summary = calculateSummary(state);
  const calculated = calculatePaymentAmount(paymentModal, summary.paymentBasis);
  const isPercent = paymentModal.mode === "percent";
  return `
    <div class="modal-backdrop">
      <section class="payment-modal" role="dialog" aria-modal="true" aria-labelledby="payment-modal-title">
        <button class="modal-close" type="button" aria-label="Luk">×</button>
        <form id="payment-modal-form">
          <div class="modal-content">
            <p class="modal-step">Ny betaling</p>
            <h2 id="payment-modal-title">Tilføj betaling</h2>
            <div class="payment-mode-switch" aria-label="Vælg beregning">
              <button class="${isPercent ? "" : "selected"}" type="button" data-payment-mode="fixed">
                <span>DKK</span>
                Fast beløb
              </button>
              <button class="${isPercent ? "selected" : ""}" type="button" data-payment-mode="percent">
                <span>%</span>
                Procent af løn
              </button>
            </div>
            <div class="modal-form-grid">
              <label class="field modal-wide">
                <span>Navn på betaling</span>
                <input id="payment-name" data-modal-field="bill" value="${escapeHTML(paymentModal.bill)}" placeholder="Fx telefon" required>
              </label>
              <label class="field">
                <span>Dato</span>
                <input type="date" data-modal-field="date" value="${escapeHTML(paymentModal.date)}" required>
              </label>
              <div class="field category-field">
                <span>Kategori</span>
                <div class="category-control">
                  <select data-modal-field="category">${paymentCategoryOptions(paymentModal.category)}</select>
                  <button id="toggle-category-manager" class="category-add-button" type="button"
                    title="Tilføj eller fjern kategorier" aria-label="Tilføj eller fjern kategorier">+</button>
                </div>
                ${paymentModal.categoryManagerOpen ? categoryManagerMarkup() : ""}
              </div>
              <label class="field">
                <span>${isPercent ? "Procent af løn" : "Beløb i DKK"}</span>
                <input type="number" min="0.01" step="0.01" data-modal-field="amount"
                  value="${escapeHTML(paymentModal.amount)}" placeholder="${isPercent ? "10" : "750"}" required>
              </label>
              <label class="field">
                <span>Status</span>
                <select data-modal-field="status">
                  ${option("planned", paymentModal.status, "Planlagt")}
                  ${option("paid", paymentModal.status, "Betalt")}
                  ${option("skipped", paymentModal.status, "Sprunget over")}
                </select>
              </label>
              <label class="field modal-wide">
                <span>Noter</span>
                <input data-modal-field="notes" value="${escapeHTML(paymentModal.notes)}" placeholder="Valgfrit">
              </label>
            </div>
            <div class="payment-preview">
              <span id="payment-modal-basis-label">${isPercent ? `${numberValue(paymentModal.amount)}% af ${formatMoney(summary.paymentBasis)}` : "Beregnet betaling"}</span>
              <strong id="payment-modal-preview">${formatMoney(calculated)}</strong>
            </div>
          </div>
          <div class="modal-footer">
            <button class="modal-text-button" type="button" data-modal-action="cancel">Annuller</button>
            <button class="primary-button" type="submit">Gem betaling</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function categoryManagerMarkup() {
  const customCategories = state.customPaymentCategories || [];
  return `
    <div class="category-manager">
      <div class="category-create-row">
        <input id="new-category-name" maxlength="30" placeholder="Ny kategori"
          aria-label="Navn på ny kategori" autocomplete="off">
        <button id="add-category-button" type="button" aria-label="Tilføj kategori">+</button>
      </div>
      <div class="category-list">
        ${DEFAULT_PAYMENT_CATEGORIES.map((category) => `
          <span class="category-chip protected">${escapeHTML(category)}</span>
        `).join("")}
        ${customCategories.map((category) => `
          <span class="category-chip">
            ${escapeHTML(category)}
            <button type="button" data-delete-category="${escapeHTML(category)}"
              title="Slet ${escapeHTML(category)}" aria-label="Slet ${escapeHTML(category)}">×</button>
          </span>
        `).join("")}
      </div>
      <small>Standardkategorier kan ikke slettes.</small>
    </div>
  `;
}

function addPaymentCategory() {
  readPaymentModalFields();
  const input = document.querySelector("#new-category-name");
  const name = input.value.trim().replace(/\s+/g, " ");
  if (!name) return;
  const exists = paymentCategories().some((category) => category.toLocaleLowerCase("da-DK") === name.toLocaleLowerCase("da-DK"));
  if (exists) {
    showToast("Kategorien findes allerede.");
    return;
  }
  state.customPaymentCategories ||= [];
  state.customPaymentCategories.push(name);
  paymentModal.category = name;
  saveState();
  renderPaymentModal();
}

function deletePaymentCategory(category) {
  readPaymentModalFields();
  state.customPaymentCategories = (state.customPaymentCategories || []).filter((item) => item !== category);
  state.payments.forEach((payment) => {
    if (payment.category === category) payment.category = "Andet";
  });
  if (paymentModal.category === category) paymentModal.category = "Andet";
  saveState();
  renderPaymentModal();
  renderPayments();
}

function readPaymentModalFields() {
  document.querySelectorAll("#modal-root [data-modal-field]").forEach((input) => {
    paymentModal[input.dataset.modalField] = input.value;
  });
}

function updatePaymentModalPreview() {
  readPaymentModalFields();
  const preview = document.querySelector("#payment-modal-preview");
  if (!preview) return;
  const summary = calculateSummary(state);
  preview.textContent = formatMoney(calculatePaymentAmount(paymentModal, summary.paymentBasis));
  const label = document.querySelector("#payment-modal-basis-label");
  if (label && paymentModal.mode === "percent") {
    label.textContent = `${numberValue(paymentModal.amount)}% af ${formatMoney(summary.paymentBasis)}`;
  }
}

function savePaymentFromModal(event) {
  event.preventDefault();
  readPaymentModalFields();
  const amount = Math.max(0, numberValue(paymentModal.amount));
  if (!paymentModal.bill.trim() || amount <= 0) return;
  state.payments.push({
    id: createId(),
    date: paymentModal.date,
    bill: paymentModal.bill.trim(),
    category: paymentModal.category,
    status: paymentModal.status,
    mode: paymentModal.mode,
    amount,
    notes: paymentModal.notes.trim()
  });
  saveState();
  closePaymentModal();
  renderAll();
  showToast("Betalingen er tilføjet.");
}

function handlePaymentChange(event) {
  const id = event.target.closest("tr").dataset.paymentId;
  const payment = state.payments.find((item) => item.id === id);
  if (!payment) return;
  const field = event.target.dataset.paymentField;
  payment[field] = field === "amount" ? Math.max(0, numberValue(event.target.value)) : event.target.value;
  saveState();
  renderAll();
}

function removePayment(event) {
  const id = event.target.closest("tr").dataset.paymentId;
  state.payments = state.payments.filter((payment) => payment.id !== id);
  saveState();
  renderAll();
}

function renderExtras() {
  const summary = calculateSummary(state);
  views.extras.innerHTML = `
    ${heading("Ferie & Fritvalg", "Puljerne holdes adskilt og kan hver især tælles med i beløbet efter betalinger.")}
    <div class="two-column">
      <article class="panel">
        <div class="panel-heading red"><h2>Ferie</h2><small>${state.settings.ferieRate * 100}% af lønnen</small></div>
        <div class="panel-body">
          <dl class="metric-list">
            <div class="metric-row"><dt>Beregnet ferie</dt><dd>${formatMoney(summary.eligiblePay * state.settings.ferieRate)}</dd></div>
            <div class="metric-row">
              <dt>Manuel ferie</dt>
              <dd><input id="manual-ferie" class="table-input" type="number" min="0" step="0.01" value="${state.manualFerie}"></dd>
            </div>
            <div class="metric-row total"><dt>Ferie i alt</dt><dd>${formatMoney(summary.ferieGross)}</dd></div>
          </dl>
        </div>
      </article>
      <article class="panel">
        <div class="panel-heading"><h2>Fritvalg</h2><small>${state.settings.fritvalgRate * 100}% af lønnen</small></div>
        <div class="panel-body">
          <dl class="metric-list">
            <div class="metric-row"><dt>Beregnet fritvalg</dt><dd>${formatMoney(summary.eligiblePay * state.settings.fritvalgRate)}</dd></div>
            <div class="metric-row">
              <dt>Manuelt fritvalg</dt>
              <dd><input id="manual-fritvalg" class="table-input" type="number" min="0" step="0.01" value="${state.manualFritvalg}"></dd>
            </div>
            <div class="metric-row total"><dt>Fritvalg i alt</dt><dd>${formatMoney(summary.fritvalgGross)}</dd></div>
          </dl>
        </div>
      </article>
    </div>

    <article class="panel" style="margin-top:16px">
      <div class="panel-heading green"><h2>Tæl med efter betalinger</h2></div>
      <div class="panel-body">
        <div class="toggle-row">
          <div><strong>Tæl ferie med</strong><small>Ferie efter 8% bruttoferiekort og 8% AM-bidrag</small></div>
          <label class="switch">
            <input id="include-ferie" type="checkbox" ${state.includeFerie ? "checked" : ""}>
            <span></span>
          </label>
        </div>
        <div class="toggle-row">
          <div><strong>Tæl fritvalg med</strong><small>Fritvalg efter 8% bruttoferiekort og 8% AM-bidrag</small></div>
          <label class="switch">
            <input id="include-fritvalg" type="checkbox" ${state.includeFritvalg ? "checked" : ""}>
            <span></span>
          </label>
        </div>
      </div>
    </article>
  `;

  document.querySelector("#manual-ferie").addEventListener("blur", (event) => {
    state.manualFerie = Math.max(0, numberValue(event.target.value));
    saveState();
    renderAll();
  });
  document.querySelector("#manual-fritvalg").addEventListener("blur", (event) => {
    state.manualFritvalg = Math.max(0, numberValue(event.target.value));
    saveState();
    renderAll();
  });
  document.querySelector("#include-ferie").addEventListener("change", (event) => {
    state.includeFerie = event.target.checked;
    saveState();
    renderAll();
  });
  document.querySelector("#include-fritvalg").addEventListener("change", (event) => {
    state.includeFritvalg = event.target.checked;
    saveState();
    renderAll();
  });
}

function renderSettings() {
  views.settings.innerHTML = `
    ${heading("Indstillinger", "Løn, sync og satser samlet et sted.")}
    <div class="settings-overview">
      <article>
        <span>Grundløn</span>
        <strong>${formatMoney(state.settings.baseWage)}</strong>
        <small>Bruges til mål og timeberegning.</small>
      </article>
      <article>
        <span>Konto</span>
        <strong>${currentUser ? escapeHTML(currentUser.username) : "…"}</strong>
        <small>Vagter, betalinger og indstillinger syncer. Valgt måned bliver på denne enhed.</small>
      </article>
      <article>
        <span>Ferie / fritvalg</span>
        <strong>${state.includeFerie || state.includeFritvalg ? "Tæller med" : "Adskilt"}</strong>
        <small>Du styrer puljerne på Opsparing-siden.</small>
      </article>
    </div>
    <div class="two-column">
      <article class="panel">
        <div class="panel-heading"><h2>Løn og opsparing</h2></div>
        <div class="panel-body form-grid">
          ${settingField("Grundløn pr. time", "baseWage", state.settings.baseWage)}
          <label class="field">
            <span>Tillægsniveau</span>
            <select id="supplement-factor">
              <option value="1" ${state.settings.supplementFactor === 1 ? "selected" : ""}>Fuldt tillæg</option>
              <option value="0.5" ${state.settings.supplementFactor === 0.5 ? "selected" : ""}>Halvt tillæg</option>
            </select>
          </label>
          ${settingField("Ferieprocent", "ferieRate", state.settings.ferieRate * 100)}
          ${settingField("Fritvalgsprocent", "fritvalgRate", state.settings.fritvalgRate * 100)}
          ${settingField("Bruttoferiekort", "bruttoRate", state.settings.bruttoRate * 100)}
          ${settingField("AM-bidrag", "amRate", state.settings.amRate * 100)}
        </div>
      </article>

      <article class="panel">
        <div class="panel-heading red"><h2>Pause-regler</h2></div>
        <div class="panel-body">
          <dl class="metric-list">
            <div class="metric-row"><dt>Over 4:31 timer</dt><dd>30 min</dd></div>
            <div class="metric-row"><dt>Fra 6:00 timer</dt><dd>30 min</dd></div>
            <div class="metric-row"><dt>Fra 10:00 timer</dt><dd>75 min</dd></div>
          </dl>
          <p class="panel-note">En manuel pause i Time Log tilsidesætter den automatiske pause.</p>
        </div>
      </article>
    </div>

    <article class="panel rates-panel">
      <div class="panel-heading"><h2>Tillægssatser</h2><small>DKK pr. time</small></div>
      <div class="table-scroll">
        <table class="rates-table">
          <thead>
            <tr><th>Gælder fra</th><th>Aften 18-23</th><th>Nat 23-06</th><th>Lørdag 15-24</th><th>Søn-/helligdag</th></tr>
          </thead>
          <tbody>
            ${state.settings.rates.map((rate, index) => `
              <tr data-rate-index="${index}">
                <td><input class="table-input" type="date" data-rate-field="from" value="${rate.from}"></td>
                <td><input class="table-input" type="number" step="0.01" data-rate-field="evening" value="${rate.evening}"></td>
                <td><input class="table-input" type="number" step="0.01" data-rate-field="night" value="${rate.night}"></td>
                <td><input class="table-input" type="number" step="0.01" data-rate-field="saturday" value="${rate.saturday}"></td>
                <td><input class="table-input" type="number" step="0.01" data-rate-field="sunday" value="${rate.sunday}"></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </article>

    <article class="panel sync-settings-panel">
      <div class="panel-heading"><h2>Vagtplan fra UKG</h2></div>
      <div class="panel-body">
        <p>Indsæt din personlige kalender-URL fra UKG (Min arbejdsplan → del/synkroniser →
        <em>Other (Copy URL)</em>). Vagterne hentes automatisk hver time.</p>
        <div class="schedule-row">
          <input id="schedule-url" type="url" inputmode="url" spellcheck="false"
                 placeholder="https://…/api/calendar_sync/…"
                 aria-label="UKG kalender-URL">
          <button id="schedule-save" class="secondary-modal-button" type="button">Gem</button>
          <button id="schedule-refresh" class="primary-button" type="button">Hent vagter nu</button>
        </div>
        <small id="schedule-status">${scheduleStatusText()}</small>
        <small>Behandl adressen som en adgangskode — alle med den kan se hele din vagtplan.
        Vagter du selv har rettet bliver aldrig overskrevet.</small>
      </div>
    </article>

    <article class="panel sync-settings-panel">
      <div class="panel-heading"><h2>Discord-beskeder</h2></div>
      <div class="panel-body">
        <p>Indsæt en Discord webhook-URL (Kanalindstillinger → Integrationer → Webhooks).
        Du får besked når vagtplanen ændrer sig, og en opsamling den sidste dag i måneden.</p>
        <div class="schedule-row">
          <input id="discord-url" type="url" inputmode="url" spellcheck="false"
                 placeholder="https://discord.com/api/webhooks/…"
                 aria-label="Discord webhook-URL">
          <button id="discord-save" class="secondary-modal-button" type="button">Gem</button>
          <button id="discord-test" class="primary-button" type="button">Send test</button>
          <button id="discord-link" class="secondary-modal-button" type="button">Forbind Discord</button>
        </div>
        <small id="discord-status">${discordStatusText()}</small>
        <small>Vagtplanen hentes automatisk hver dag på serveren — også når appen er lukket.</small>
      </div>
    </article>

    <article class="panel sync-settings-panel">
      <div class="panel-heading"><h2>Din konto</h2></div>
      <div class="panel-body sync-settings-row">
        <div>
          <strong>Logget ind som ${currentUser ? escapeHTML(currentUser.username) : "…"}</strong>
          <p>Din plan følger kontoen. Log ind på mobil, tablet eller computer for at se den samme plan.</p>
          <small>Den valgte lønperiode syncer ikke, så hver enhed kan kigge på sin egen måned.</small>
        </div>
        <div class="sync-actions">
          ${currentUser?.role === "admin"
            ? '<a class="secondary-modal-button" href="/admin">Administration</a>'
            : ""}
          <button id="settings-logout" class="primary-button" type="button">Log ud</button>
        </div>
      </div>
    </article>

    <div class="settings-actions">
      <button id="reset-data" class="danger-button" type="button">Nulstil appdata</button>
    </div>
  `;

  views.settings.querySelectorAll("[data-setting]").forEach((input) => {
    input.addEventListener("blur", handleSettingChange);
  });
  document.querySelector("#supplement-factor").addEventListener("change", (event) => {
    state.settings.supplementFactor = numberValue(event.target.value);
    saveState();
    renderAll();
  });
  views.settings.querySelectorAll("[data-rate-field]").forEach((input) => {
    input.addEventListener("blur", handleRateChange);
  });
  on("#schedule-save", "click", saveScheduleUrl);
  on("#schedule-refresh", "click", async () => {
    showToast("Henter vagtplan…");
    await importSchedule();
  });
  on("#discord-save", "click", saveDiscordWebhook);
  on("#discord-test", "click", testDiscordWebhook);
  on("#discord-link", "click", createDiscordLinkCode);
  on("#settings-logout", "click", signOut);
  on("#reset-data", "click", resetData);
}

function settingField(label, key, value) {
  return `
    <label class="field">
      <span>${label}</span>
      <input type="number" min="0" step="0.01" data-setting="${key}" value="${inputNumber(value)}">
    </label>
  `;
}

function handleSettingChange(event) {
  const key = event.target.dataset.setting;
  const value = Math.max(0, numberValue(event.target.value));
  state.settings[key] = key.endsWith("Rate") ? value / 100 : value;
  saveState();
  renderAll();
}

function handleRateChange(event) {
  const index = Number(event.target.closest("tr").dataset.rateIndex);
  const field = event.target.dataset.rateField;
  state.settings.rates[index][field] = field === "from" ? event.target.value : Math.max(0, numberValue(event.target.value));
  saveState();
  renderAll();
}

function resetData() {
  if (!window.confirm("Vil du nulstille alle vagter, betalinger og indstillinger?")) return;
  state = initialState();
  saveState();
  renderAll();
  showToast("Appdata er nulstillet.");
}

function activateTab(tabName) {
  activeTab = tabName;
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabName));
  Object.entries(views).forEach(([name, view]) => view.classList.toggle("active", name === tabName));
  if (tabName === "dashboard") drawPayChart(calculateSummary(state));
}

function changePeriod(months) {
  const next = addMonths(parseISODate(state.periodStart), months);
  state.periodStart = toISODate(next);
  savePeriodView();
  renderAll();
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `bilka-pay-backup-${state.periodStart}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("Backup er eksporteret.");
}

async function importData(event) {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!imported.periodStart || !imported.settings || !imported.shifts) throw new Error("Invalid backup");
    state = {
      ...initialState(),
      ...imported,
      settings: { ...structuredClone(DEFAULT_SETTINGS), ...imported.settings }
    };
    saveState();
    renderAll();
    showToast("Backup er importeret.");
  } catch {
    showToast("Filen kunne ikke importeres.");
  } finally {
    event.target.value = "";
  }
}

// A missing element used to throw here and abort the rest of the module, which
// silently took sync and the schedule import down with it. One absent button
// should cost that button, nothing more.
function on(selector, event, handler) {
  const element = document.querySelector(selector);
  if (!element) {
    console.warn(`Bilka Pay: no element matches ${selector}`);
    return;
  }
  element.addEventListener(event, handler);
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});
on("#previous-period", "click", () => changePeriod(-1));
on("#next-period", "click", () => changePeriod(1));
function goToCurrentPeriod() {
  state.periodStart = toISODate(getPayPeriodStart(new Date()));
  savePeriodView();
  renderAll();
}
on("#current-period", "click", goToCurrentPeriod);
on("#jump-current-period", "click", goToCurrentPeriod);
on("#sign-out", "click", signOut);
on("#theme-toggle", "click", toggleTheme);
on("#export-data", "click", exportData);
on("#import-data", "change", importData);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && paymentModal) closePaymentModal();
});
window.addEventListener("resize", () => {
  if (activeTab === "dashboard") drawPayChart(calculateSummary(state));
});

async function loadCurrentUser() {
  try {
    const response = await fetch("/api/me", { cache: "no-store" });
    if (handleSignedOut(response)) return false;
    if (!response.ok) return false;
    currentUser = (await response.json()).user;
    const adminLink = document.querySelector("#admin-link");
    if (adminLink) adminLink.hidden = currentUser.role !== "admin";
    return true;
  } catch {
    return false;
  }
}

applyTheme(storedTheme(), { persist: false });
renderAll();
// The account has to be known before the plan loads, so the header and the
// settings panel do not flash a signed-out state first.
loadCurrentUser().then(async () => {
  renderAll();
  await reconcileSyncPlan();
  await Promise.all([loadScheduleStatus(), loadDiscordStatus()]);
  renderAll();
  // Pull the roster after the plan, so an import merges onto current data
  // rather than a stale local copy and then immediately conflicts.
  if (scheduleSource?.configured) await importSchedule({ silent: true });
  startAutoSync();
});
