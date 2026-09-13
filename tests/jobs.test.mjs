import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilePlanStore } from "../plan-store.js";
import { mergeSchedule } from "../schedule-merge.js";
import { isLastDayOfMonth, runDailyJobs, todayInZone } from "../jobs.js";
import { DiscordError, buildScheduleChangeMessage, parseWebhookUrl } from "../discord.js";

const WEBHOOK = "https://discord.com/api/webhooks/123456789/abcDEF-ghi_JKL";

function calendarWith(dates) {
  const events = dates.map(([date, start, end]) => [
    "BEGIN:VEVENT",
    "SUMMARY:Vagt",
    `DTSTART:${date}T${start}00Z`,
    `DTEND:${date}T${end}00Z`,
    "STATUS:CONFIRMED",
    "END:VEVENT"
  ].join("\r\n"));
  return ["BEGIN:VCALENDAR", ...events, "END:VCALENDAR"].join("\r\n");
}

async function storeWithUser(context, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bilka-jobs-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FilePlanStore(directory);
  await store.initialize();
  const user = await store.createUser({ username: "anna", passwordHash: "x" });
  await store.updateUser(user.id, {
    scheduleUrl: "https://feeds.example/anna.ics",
    discordWebhook: WEBHOOK,
    ...extra
  });
  return { store, user };
}

test("merge adds, updates and withdraws only imported shifts", () => {
  const existing = {
    "2026-08-07": { time: "15:00-19:00", source: "ukg" },
    "2026-08-08": { time: "09:00-12:00" },
    "2026-08-09": { time: "18:45-22:00", source: "ukg" }
  };
  const imported = {
    "2026-08-07": { time: "16:00-20:00", source: "ukg" },
    "2026-08-08": { time: "10:00-14:00", source: "ukg" },
    "2026-08-10": { time: "12:00-15:00", source: "ukg" }
  };

  const result = mergeSchedule(existing, imported, { from: "2026-08-07", to: "2026-08-10" });

  assert.deepEqual(result.added, [{ date: "2026-08-10", time: "12:00-15:00" }]);
  assert.deepEqual(result.updated, [
    { date: "2026-08-07", time: "16:00-20:00", was: "15:00-19:00" }
  ]);
  assert.deepEqual(result.removed, [{ date: "2026-08-09", time: "18:45-22:00" }]);
  // The hand-entered one is untouched even though the feed disagrees.
  assert.deepEqual(result.shifts["2026-08-08"], { time: "09:00-12:00" });
  assert.equal(result.kept, 1);
});

test("shifts outside the feed's range are never withdrawn", () => {
  const existing = {
    "2026-05-01": { time: "10:00-14:00", source: "ukg" },
    "2026-08-07": { time: "15:00-19:00", source: "ukg" }
  };
  const result = mergeSchedule(existing, {}, { from: "2026-08-01", to: "2026-08-31" });

  assert.deepEqual(result.removed, [{ date: "2026-08-07", time: "15:00-19:00" }]);
  assert.ok(result.shifts["2026-05-01"], "an older period must survive");
});

test("a user-set pause survives a roster change", () => {
  const result = mergeSchedule(
    { "2026-08-07": { time: "15:00-19:00", source: "ukg", pauseOverride: 45 } },
    { "2026-08-07": { time: "16:00-21:00", source: "ukg" } },
    { from: "2026-08-07", to: "2026-08-07" }
  );
  assert.equal(result.shifts["2026-08-07"].pauseOverride, 45);
  assert.equal(result.shifts["2026-08-07"].time, "16:00-21:00");
});

test("month ends are detected across leap years", () => {
  for (const date of ["2026-01-31", "2026-04-30", "2026-02-28", "2028-02-29", "2026-12-31"]) {
    assert.equal(isLastDayOfMonth(date), true, date);
  }
  for (const date of ["2026-01-30", "2026-02-27", "2028-02-28", "2026-08-18"]) {
    assert.equal(isLastDayOfMonth(date), false, date);
  }
});

test("today is resolved in the configured zone", () => {
  // 22:30 UTC is already the next day in Copenhagen during summer.
  const instant = new Date("2026-08-07T22:30:00Z");
  assert.equal(todayInZone("Europe/Copenhagen", instant), "2026-08-08");
  assert.equal(todayInZone("UTC", instant), "2026-08-07");
});

test("only real Discord webhook URLs are accepted", () => {
  assert.equal(parseWebhookUrl(WEBHOOK).hostname, "discord.com");
  for (const bad of [
    "https://evil.example/api/webhooks/1/abc",
    "http://discord.com/api/webhooks/1/abc",
    "https://discord.com/api/notwebhooks/1/abc",
    "https://192.168.86.181:8006/",
    "nonsense"
  ]) {
    assert.throws(() => parseWebhookUrl(bad), (error) => error instanceof DiscordError, bad);
  }
});

test("the change message names each affected day", () => {
  const message = buildScheduleChangeMessage({
    added: [{ date: "2026-08-12", time: "15:00-19:00" }],
    updated: [{ date: "2026-08-14", time: "16:00-20:00", was: "18:45-22:00" }],
    removed: [{ date: "2026-08-18", time: "18:45-22:00" }]
  });

  assert.match(message.content, /1 ny/);
  assert.match(message.content, /\+ ons 12\. aug {2}15:00-19:00/);
  assert.match(message.content, /~ fre 14\. aug {2}18:45-22:00 → 16:00-20:00/);
  assert.match(message.content, /− tir 18\. aug {2}18:45-22:00 \(aflyst\)/);
});

test("the daily job imports, saves and reports the change once", async (context) => {
  const { store, user } = await storeWithUser(context);
  await store.savePlan(user.id, { updatedAt: "2026-08-01T10:00:00.000Z", shifts: {} });

  const sent = [];
  const deps = {
    fetchCalendarFeed: async () => calendarWith([["20260807", "1300", "1700"]]),
    sendDiscordMessage: async (url, payload) => sent.push({ url, payload })
  };
  const now = new Date("2026-08-07T09:00:00Z");

  const first = await runDailyJobs(store, { deps, now, log() {} });
  assert.equal(first.synced, 1);
  assert.equal(first.notified, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, WEBHOOK);
  assert.match(sent[0].payload.content, /15:00-19:00/);

  const plan = await store.loadPlan(user.id);
  assert.equal(plan.state.shifts["2026-08-07"].time, "15:00-19:00");

  // Running again the same day must not re-import or re-notify.
  const second = await runDailyJobs(store, { deps, now, log() {} });
  assert.equal(second.synced, 0);
  assert.equal(sent.length, 1);
});

test("an unchanged roster produces no Discord noise", async (context) => {
  const { store, user } = await storeWithUser(context);
  await store.savePlan(user.id, {
    updatedAt: "2026-08-01T10:00:00.000Z",
    shifts: { "2026-08-07": { time: "15:00-19:00", source: "ukg", pauseOverride: null } }
  });

  const sent = [];
  const report = await runDailyJobs(store, {
    deps: {
      fetchCalendarFeed: async () => calendarWith([["20260807", "1300", "1700"]]),
      sendDiscordMessage: async (...args) => sent.push(args)
    },
    now: new Date("2026-08-07T09:00:00Z"),
    log() {}
  });

  assert.equal(report.synced, 1);
  assert.equal(report.notified, 0);
  assert.equal(sent.length, 0);
});

test("a failing feed is retried rather than marked done", async (context) => {
  const { store, user } = await storeWithUser(context);
  await store.savePlan(user.id, { updatedAt: "2026-08-01T10:00:00.000Z", shifts: {} });

  const report = await runDailyJobs(store, {
    deps: {
      fetchCalendarFeed: async () => { throw new Error("UKG is down"); },
      sendDiscordMessage: async () => {}
    },
    now: new Date("2026-08-07T09:00:00Z"),
    log() {}
  });

  assert.equal(report.failed, 1);
  assert.equal(report.synced, 0);
  // No date stamp, so the next pass tries again instead of waiting a day.
  assert.equal((await store.findUserById(user.id)).schedule_synced_on, undefined);
});

test("a dead webhook does not stop the schedule being saved", async (context) => {
  const { store, user } = await storeWithUser(context);
  await store.savePlan(user.id, { updatedAt: "2026-08-01T10:00:00.000Z", shifts: {} });

  const report = await runDailyJobs(store, {
    deps: {
      fetchCalendarFeed: async () => calendarWith([["20260807", "1300", "1700"]]),
      sendDiscordMessage: async () => { throw new DiscordError("gone", 404); }
    },
    now: new Date("2026-08-07T09:00:00Z"),
    log() {}
  });

  assert.equal(report.synced, 1);
  assert.equal(report.notified, 0);
  const plan = await store.loadPlan(user.id);
  assert.equal(plan.state.shifts["2026-08-07"].time, "15:00-19:00");
});

test("the month-end reminder fires once on the last day only", async (context) => {
  const { store, user } = await storeWithUser(context, { scheduleUrl: null });
  await store.savePlan(user.id, {
    updatedAt: "2026-08-01T10:00:00.000Z",
    shifts: { "2026-08-07": { time: "15:00-19:00", source: "ukg" } }
  });

  const sent = [];
  const deps = { sendDiscordMessage: async (url, payload) => sent.push(payload) };

  const midMonth = await runDailyJobs(store, {
    deps, now: new Date("2026-08-20T09:00:00Z"), log() {}
  });
  assert.equal(midMonth.reminded, 0);

  const lastDay = await runDailyJobs(store, {
    deps, now: new Date("2026-08-31T09:00:00Z"), log() {}
  });
  assert.equal(lastDay.reminded, 1);
  assert.match(sent[0].content, /Månedsopsamling/);

  // A restart on the same day must not send it twice.
  const again = await runDailyJobs(store, {
    deps, now: new Date("2026-08-31T15:00:00Z"), log() {}
  });
  assert.equal(again.reminded, 0);
  assert.equal(sent.length, 1);
});

test("a user who has never opened the app is skipped, not given a fabricated plan",
  async (context) => {
    const { store, user } = await storeWithUser(context);
    const sent = [];

    const report = await runDailyJobs(store, {
      deps: {
        fetchCalendarFeed: async () => calendarWith([["20260807", "1300", "1700"]]),
        sendDiscordMessage: async (url, payload) => sent.push(payload)
      },
      now: new Date("2026-08-07T09:00:00Z"),
      log() {}
    });

    assert.equal(report.notified, 0);
    assert.equal(await store.loadPlan(user.id), null);
    assert.equal(sent.length, 0);
  });
