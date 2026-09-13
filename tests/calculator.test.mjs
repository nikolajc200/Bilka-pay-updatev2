import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  calculatePaymentAmount,
  calculateShift,
  getDanishHolidayName,
  getAutomaticBreakMinutes,
  getPayPeriodDates,
  getRateForDate,
  roundHoursUpToTenMinutes
} from "../calculator.js";

test("rate lookup survives an emptied or half-filled rate table", () => {
  const expected = DEFAULT_SETTINGS.rates[0];

  assert.deepEqual(getRateForDate("2026-08-03", { rates: [] }), expected);
  assert.deepEqual(getRateForDate("2026-08-03", {}), expected);

  // A row whose "from" was cleared must not win by comparing as the earliest date.
  const withBlankRow = {
    rates: [
      { from: "", evening: 999, night: 999, saturday: 999, sunday: 999 },
      { from: "2025-05-01", evening: 16.08, night: 21.58, saturday: 28.28, sunday: 31.5 }
    ]
  };
  assert.equal(getRateForDate("2026-08-03", withBlankRow).evening, 16.08);
});

test("pay period contains every date from the 19th until the next 19th", () => {
  const dates = getPayPeriodDates("2026-04-19");
  assert.equal(dates[0], "2026-04-19");
  assert.equal(dates.at(-1), "2026-05-18");
  assert.equal(dates.length, 30);
});

test("automatic break uses the requested 30 minute six-hour rule", () => {
  assert.equal(getAutomaticBreakMinutes(4.5), 0);
  assert.equal(getAutomaticBreakMinutes(4 + 32 / 60), 30);
  assert.equal(getAutomaticBreakMinutes(6), 30);
  assert.equal(getAutomaticBreakMinutes(10), 75);
});

test("Saturday supplement begins at 15:00 and does not stack", () => {
  const shift = calculateShift("2026-05-02", { time: "14:00-16:00", pauseOverride: 0 }, DEFAULT_SETTINGS);
  assert.equal(shift.paidHours, 2);
  assert.equal(shift.saturdayHours, 1);
  assert.equal(shift.weekdaySupplementHours, 0);
  assert.equal(shift.sundayHours, 0);
  assert.equal(Number(shift.totalPay.toFixed(2)), 190.28);
});

test("Sunday receives one full-day supplement", () => {
  const shift = calculateShift("2026-05-03", { time: "18:00-22:00", pauseOverride: 0 }, DEFAULT_SETTINGS);
  assert.equal(shift.sundayHours, 4);
  assert.equal(shift.weekdaySupplementHours, 0);
  assert.equal(Number(shift.totalPay.toFixed(2)), 450);
});

test("Danish public holidays are detected automatically", () => {
  assert.equal(getDanishHolidayName("2026-04-02"), "Skærtorsdag");
  assert.equal(getDanishHolidayName("2026-05-14"), "Kristi himmelfartsdag");
  assert.equal(getDanishHolidayName("2026-05-01"), null);
  assert.equal(getDanishHolidayName("2026-06-05"), null);
});

test("holiday shifts receive the Sunday and holiday supplement automatically", () => {
  const shift = calculateShift("2026-05-14", { time: "12:00-16:00", pauseOverride: 0 }, DEFAULT_SETTINGS);
  assert.equal(shift.holidayName, "Kristi himmelfartsdag");
  assert.equal(shift.sundayHours, 4);
  assert.equal(Number(shift.totalPay.toFixed(2)), 450);
});

test("payments can be fixed amounts or a percentage of available pay", () => {
  assert.equal(calculatePaymentAmount({ mode: "fixed", amount: 750 }, 5000), 750);
  assert.equal(calculatePaymentAmount({ mode: "percent", amount: 10 }, 5000), 500);
});

test("goal and payment hours round upward to ten minutes", () => {
  assert.equal(roundHoursUpToTenMinutes(1.9), 2);
  assert.equal(roundHoursUpToTenMinutes(1.82), 11 / 6);
  assert.equal(roundHoursUpToTenMinutes(1.84), 2);
});
