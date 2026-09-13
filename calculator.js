export const DEFAULT_SETTINGS = {
  baseWage: 81,
  supplementFactor: 1,
  ferieRate: 0.125,
  fritvalgRate: 0.1,
  bruttoRate: 0.08,
  amRate: 0.08,
  rates: [
    { from: "2025-05-01", evening: 16.08, night: 21.58, saturday: 28.28, sunday: 31.5 }
  ]
};

export function parseISODate(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function toISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addMonths(date, count) {
  return new Date(date.getFullYear(), date.getMonth() + count, date.getDate());
}

export function getPayPeriodStart(date = new Date()) {
  if (date.getDate() >= 19) {
    return new Date(date.getFullYear(), date.getMonth(), 19);
  }
  return new Date(date.getFullYear(), date.getMonth() - 1, 19);
}

export function getPayPeriodDates(startISO) {
  const start = parseISODate(startISO);
  const end = addMonths(start, 1);
  const dates = [];
  for (let cursor = new Date(start); cursor < end; cursor.setDate(cursor.getDate() + 1)) {
    dates.push(toISODate(cursor));
  }
  return dates;
}

export function isDateInPeriod(dateISO, startISO) {
  const date = parseISODate(dateISO);
  const start = parseISODate(startISO);
  return date >= start && date < addMonths(start, 1);
}

export function parseShift(dateISO, value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):([0-5]\d)\s*-\s*(\d{1,2}):([0-5]\d)$/);
  if (!match) return null;

  const [, startHourText, startMinuteText, endHourText, endMinuteText] = match;
  const startHour = Number(startHourText);
  const endHour = Number(endHourText);
  if (startHour > 23 || endHour > 23) return null;

  const day = parseISODate(dateISO);
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, Number(startMinuteText));
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), endHour, Number(endMinuteText));
  if (end <= start) end.setDate(end.getDate() + 1);
  return { start, end };
}

export function getAutomaticBreakMinutes(grossHours) {
  if (grossHours >= 10) return 75;
  if (grossHours >= 6) return 30;
  if (grossHours > 4 + 31 / 60) return 30;
  return 0;
}

export function getRateForDate(dateISO, settings = DEFAULT_SETTINGS) {
  // Rows with a blank "from" would otherwise always compare as active ("" <= any
  // date), and an empty list would leave nothing to fall back on at all.
  const usable = (settings.rates || []).filter((rate) => rate && typeof rate.from === "string" && rate.from);
  const source = usable.length ? usable : DEFAULT_SETTINGS.rates;
  const sorted = [...source].sort((a, b) => a.from.localeCompare(b.from));
  return sorted.reduce((active, rate) => (rate.from <= dateISO ? rate : active), sorted[0]);
}

function getEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function dateWithOffset(date, days) {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

export function getDanishHolidayName(dateISO) {
  const date = parseISODate(dateISO);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const fixedHoliday = {
    "1-1": "Nytårsdag",
    "12-25": "Juledag",
    "12-26": "2. juledag"
  }[`${month}-${day}`];
  if (fixedHoliday) return fixedHoliday;

  const easter = getEasterSunday(date.getFullYear());
  const movableHolidays = [
    [-3, "Skærtorsdag"],
    [-2, "Langfredag"],
    [0, "Påskedag"],
    [1, "2. påskedag"],
    [39, "Kristi himmelfartsdag"],
    [49, "Pinsedag"],
    [50, "2. pinsedag"]
  ];
  return movableHolidays.find(([offset]) => toISODate(dateWithOffset(easter, offset)) === dateISO)?.[1] || null;
}

export function isDanishPublicHoliday(dateISO) {
  return Boolean(getDanishHolidayName(dateISO));
}

function supplementCategoryAt(date) {
  const dateISO = toISODate(date);
  const day = date.getDay();
  const hour = date.getHours() + date.getMinutes() / 60;

  if (isDanishPublicHoliday(dateISO) || day === 0) return "sunday";
  if (day === 6) {
    if (hour >= 15) return "saturday";
    if (hour < 6) return "night";
    return null;
  }
  if (hour < 6 || hour >= 23) return "night";
  if (hour >= 18) return "evening";
  return null;
}

export function calculateShift(dateISO, entry = {}, settings = DEFAULT_SETTINGS) {
  const parsed = parseShift(dateISO, entry.time);
  const holidayName = getDanishHolidayName(dateISO);
  if (!parsed) {
    return {
      valid: !entry.time,
      holidayName,
      grossHours: 0,
      pauseMinutes: 0,
      paidHours: 0,
      weekdaySupplementHours: 0,
      saturdayHours: 0,
      sundayHours: 0,
      basePay: 0,
      supplementPay: 0,
      totalPay: 0
    };
  }

  const grossMinutes = (parsed.end - parsed.start) / 60000;
  const grossHours = grossMinutes / 60;
  const automaticPause = getAutomaticBreakMinutes(grossHours);
  const hasOverride = entry.pauseOverride !== null && entry.pauseOverride !== undefined && entry.pauseOverride !== "";
  const pauseMinutes = hasOverride ? Math.max(0, Number(entry.pauseOverride) || 0) : automaticPause;
  const paidHours = Math.max(0, grossHours - pauseMinutes / 60);
  const paidRatio = grossHours > 0 ? paidHours / grossHours : 0;
  const supplementMinutes = { evening: 0, night: 0, saturday: 0, sunday: 0 };

  for (let cursor = new Date(parsed.start); cursor < parsed.end; cursor.setMinutes(cursor.getMinutes() + 1)) {
    const category = supplementCategoryAt(cursor);
    if (category) supplementMinutes[category] += 1;
  }

  const hours = Object.fromEntries(
    Object.entries(supplementMinutes).map(([key, minutes]) => [key, (minutes / 60) * paidRatio])
  );
  const rate = getRateForDate(dateISO, settings);
  const factor = Number(settings.supplementFactor) || 0;
  const basePay = paidHours * (Number(settings.baseWage) || 0);
  const supplementPay = factor * (
    hours.evening * rate.evening
    + hours.night * rate.night
    + hours.saturday * rate.saturday
    + hours.sunday * rate.sunday
  );

  return {
    valid: true,
    holidayName,
    grossHours,
    pauseMinutes,
    paidHours,
    weekdaySupplementHours: hours.evening + hours.night,
    saturdayHours: hours.saturday,
    sundayHours: hours.sunday,
    basePay,
    supplementPay,
    totalPay: basePay + supplementPay
  };
}

export function roundHoursUpToTenMinutes(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return Math.ceil(hours * 6 - 1e-9) / 6;
}

export function calculatePaymentAmount(payment, payBasis) {
  const value = Math.max(0, Number(payment?.amount) || 0);
  return payment?.mode === "percent" ? payBasis * value / 100 : value;
}

export function calculateSummary(state) {
  const settings = state.settings || DEFAULT_SETTINGS;
  const shiftRows = getPayPeriodDates(state.periodStart).map((date) => ({
    date,
    ...calculateShift(date, state.shifts?.[date] || {}, settings)
  }));

  const basePay = shiftRows.reduce((sum, row) => sum + row.basePay, 0);
  const supplementPay = shiftRows.reduce((sum, row) => sum + row.supplementPay, 0);
  const paidHours = shiftRows.reduce((sum, row) => sum + row.paidHours, 0);
  const weekdayHours = shiftRows.reduce((sum, row) => sum + row.weekdaySupplementHours, 0);
  const saturdayHours = shiftRows.reduce((sum, row) => sum + row.saturdayHours, 0);
  const sundayHours = shiftRows.reduce((sum, row) => sum + row.sundayHours, 0);
  const eligiblePay = basePay + supplementPay;
  const ferieGross = eligiblePay * Number(settings.ferieRate) + (Number(state.manualFerie) || 0);
  const fritvalgGross = eligiblePay * Number(settings.fritvalgRate) + (Number(state.manualFritvalg) || 0);
  const extrasGross = ferieGross + fritvalgGross;
  const bruttoDeduction = extrasGross * Number(settings.bruttoRate);
  const amDeduction = (extrasGross - bruttoDeduction) * Number(settings.amRate);
  const totalGross = eligiblePay + extrasGross - bruttoDeduction - amDeduction;
  const netFactor = (1 - Number(settings.bruttoRate)) * (1 - Number(settings.amRate));

  const countedFerie = state.includeFerie ? ferieGross * netFactor : 0;
  const countedFritvalg = state.includeFritvalg ? fritvalgGross * netFactor : 0;
  const paymentBasis = eligiblePay + countedFerie + countedFritvalg;
  const periodPayments = (state.payments || []).filter((payment) =>
    isDateInPeriod(payment.date, state.periodStart) && payment.status !== "skipped"
  );
  const paymentsTotal = periodPayments.reduce(
    (sum, payment) => sum + calculatePaymentAmount(payment, paymentBasis),
    0
  );
  const paymentLeft = paymentBasis - paymentsTotal;
  const goalTarget = Number(state.goalTarget) || 0;
  const goalHoursNeeded = roundHoursUpToTenMinutes(goalTarget / Number(settings.baseWage));
  const goalHoursLeft = roundHoursUpToTenMinutes(Math.max(goalHoursNeeded - paidHours, 0));

  return {
    shiftRows,
    basePay,
    supplementPay,
    eligiblePay,
    ferieGross,
    fritvalgGross,
    bruttoDeduction,
    amDeduction,
    totalGross,
    paymentBasis,
    paymentsTotal,
    paymentLeft,
    paidHours,
    weekdayHours,
    saturdayHours,
    sundayHours,
    goalHoursNeeded,
    goalHoursLeft
  };
}

export function formatMoney(value) {
  const amount = new Intl.NumberFormat("da-DK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value) || 0);
  return `${amount} DKK`;
}

export function formatDecimalHours(value) {
  return new Intl.NumberFormat("da-DK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value) || 0);
}

export function formatHoursMinutes(value) {
  const totalMinutes = Math.round((Number(value) || 0) * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, "0")} h`;
}
