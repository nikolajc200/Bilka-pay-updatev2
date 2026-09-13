import { calculateSummary, getPayPeriodStart, toISODate } from "./calculator.js";
import {
  buildMonthlyReminderMessage,
  buildScheduleChangeMessage,
  sendDiscordMessage
} from "./discord.js";
import { mergeSchedule } from "./schedule-merge.js";
import { DEFAULT_TIME_ZONE, fetchCalendarFeed, parseScheduleFeed } from "./schedule.js";

const CHECK_INTERVAL_MS = 15 * 60_000;

/** Today's date in the user's own zone, as YYYY-MM-DD. */
export function todayInZone(timeZone = DEFAULT_TIME_ZONE, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(now).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isLastDayOfMonth(dateISO) {
  const [year, month, day] = dateISO.split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  return day === new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function localHour(timeZone, now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", hour12: false
  }).format(now));
}

function periodLabel(periodStart) {
  const formatter = new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "short" });
  const start = new Date(`${periodStart}T00:00:00`);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  end.setDate(end.getDate() - 1);
  return `${formatter.format(start)} – ${formatter.format(end)}`;
}

/**
 * Pulls one user's roster, merges it into their saved plan and reports what
 * moved. Returns null when there is nothing to do, so the caller can stay quiet.
 *
 * The plan is only ever updated in place — if the user has never opened the app
 * there is no plan to merge into, and inventing one here would overwrite the
 * settings still sitting in their browser.
 */
export async function syncUserSchedule(store, user, { timeZone = DEFAULT_TIME_ZONE, deps = {} } = {}) {
  if (!user.scheduleUrl) return null;

  const feed = await (deps.fetchCalendarFeed ?? fetchCalendarFeed)(user.scheduleUrl);
  const parsed = parseScheduleFeed(feed, { timeZone });

  const saved = await store.loadPlan(user.id);
  if (!saved?.state) return { skipped: "no-plan", parsed };

  const result = mergeSchedule(saved.state.shifts || {}, parsed.shifts, parsed);
  if (!result.changed) return { changed: false, parsed };

  const nextState = {
    ...saved.state,
    shifts: result.shifts,
    updatedAt: new Date().toISOString()
  };
  await store.savePlan(user.id, nextState);

  return {
    changed: true,
    parsed,
    added: result.added,
    updated: result.updated,
    removed: result.removed
  };
}

async function notify(store, user, payload, { deps, log }) {
  if (!user.discordWebhook) return false;
  try {
    await (deps.sendDiscordMessage ?? sendDiscordMessage)(user.discordWebhook, payload);
    return true;
  } catch (error) {
    // A dead webhook must not stop the sync itself from being recorded.
    log(`Discord notify failed for ${user.username}: ${error.message}`);
    return false;
  }
}

async function sendMonthlyReminder(store, user, { timeZone, appUrl, deps, log }) {
  const saved = await store.loadPlan(user.id);
  const state = saved?.state;
  if (!state) return false;

  const periodStart = toISODate(getPayPeriodStart(new Date()));
  const summary = calculateSummary({ ...state, periodStart });
  const worked = summary.shiftRows.filter((row) => row.paidHours > 0);

  return notify(store, user, buildMonthlyReminderMessage({
    periodLabel: periodLabel(periodStart),
    shifts: worked.length,
    hours: summary.paidHours,
    pay: summary.totalGross,
    appUrl
  }), { deps, log });
}

/**
 * One pass over every user with automation configured. Safe to call repeatedly:
 * the per-user date stamps mean a restart cannot re-send today's messages.
 */
export async function runDailyJobs(store, {
  timeZone = DEFAULT_TIME_ZONE,
  appUrl = "",
  now = new Date(),
  deps = {},
  log = console.log
} = {}) {
  const today = todayInZone(timeZone, now);
  const users = await store.listAutomationTargets();
  const report = { synced: 0, notified: 0, reminded: 0, failed: 0 };

  for (const user of users) {
    if (user.scheduleUrl && user.scheduleSyncedOn !== today) {
      try {
        const result = await syncUserSchedule(store, user, { timeZone, deps });
        await store.updateUser(user.id, { scheduleSyncedOn: today });
        report.synced += 1;

        if (result?.changed) {
          const sent = await notify(store, user, buildScheduleChangeMessage(result), { deps, log });
          if (sent) report.notified += 1;
        }
      } catch (error) {
        // Deliberately not stamping the date, so a transient failure retries
        // on the next pass instead of being skipped until tomorrow.
        report.failed += 1;
        log(`Schedule sync failed for ${user.username}: ${error.message}`);
      }
    }

    if (user.discordWebhook && isLastDayOfMonth(today) && user.reminderSentOn !== today) {
      const sent = await sendMonthlyReminder(store, user, { timeZone, appUrl, deps, log });
      if (sent) {
        await store.updateUser(user.id, { reminderSentOn: today });
        report.reminded += 1;
      }
    }
  }

  return report;
}

/**
 * Wakes every 15 minutes but only works once the local hour has arrived, so the
 * daily pass lands at a predictable time without needing a real cron.
 */
export function startScheduler(store, {
  timeZone = DEFAULT_TIME_ZONE,
  appUrl = "",
  hour = 7,
  log = console.log
} = {}) {
  const tick = async () => {
    try {
      if (localHour(timeZone) < hour) return;
      const report = await runDailyJobs(store, { timeZone, appUrl, log });
      if (report.synced || report.notified || report.reminded || report.failed) {
        log(`Daily jobs: ${JSON.stringify(report)}`);
      }
    } catch (error) {
      log(`Daily jobs error: ${error.message}`);
    }
  };

  const timer = setInterval(tick, CHECK_INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, 10_000).unref?.();
  return () => clearInterval(timer);
}
