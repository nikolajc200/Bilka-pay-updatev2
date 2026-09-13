import assert from "node:assert/strict";
import test from "node:test";
import {
  ScheduleError,
  assertPublicHttpsUrl,
  fetchCalendarFeed,
  isPrivateAddress,
  parseScheduleFeed
} from "../schedule.js";

const publicDns = async () => [{ address: "203.0.113.10", family: 4 }];
const privateDns = async () => [{ address: "192.168.86.124", family: 4 }];

function calendar(events) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
}

function shift({ start, end, summary = "Salling Group-Vagt", status = "CONFIRMED", extra = [] }) {
  return [
    "BEGIN:VEVENT",
    `SUMMARY:${summary}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `STATUS:${status}`,
    ...extra,
    "END:VEVENT"
  ].join("\r\n");
}

test("private and loopback addresses are recognised", () => {
  for (const ip of [
    "127.0.0.1", "10.0.0.5", "192.168.86.124", "172.16.4.1", "172.31.255.255",
    "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1",
    "::ffff:192.168.1.1"
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
  for (const ip of ["203.0.113.10", "8.8.8.8", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test("only public https URLs are accepted", async () => {
  await assert.rejects(
    () => assertPublicHttpsUrl("http://example.com/feed.ics", { resolve: publicDns }),
    /https/
  );
  await assert.rejects(() => assertPublicHttpsUrl("not a url", { resolve: publicDns }), /Ugyldig/);
  await assert.rejects(
    () => assertPublicHttpsUrl("file:///etc/passwd", { resolve: publicDns }),
    /https/
  );

  // The whole point: the app sits on the same LAN as everything else.
  await assert.rejects(
    () => assertPublicHttpsUrl("https://192.168.86.181:8006/", { resolve: privateDns }),
    (error) => error instanceof ScheduleError && error.status === 403
  );

  const ok = await assertPublicHttpsUrl("https://example.com/feed.ics", { resolve: publicDns });
  assert.equal(ok.host, "example.com");
});

test("a redirect cannot smuggle the fetch onto the private network", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("start")) {
      return {
        status: 302,
        ok: false,
        headers: new Headers({ location: "https://internal.example/admin" })
      };
    }
    throw new Error("should never be reached");
  };
  const resolve = async (hostname) => (hostname === "internal.example"
    ? [{ address: "10.0.0.9", family: 4 }]
    : [{ address: "203.0.113.10", family: 4 }]);

  await assert.rejects(
    () => fetchCalendarFeed("https://feeds.example/start", { resolve, fetchImpl }),
    (error) => error.status === 403
  );
});

test("a non-calendar response is refused", async () => {
  const fetchImpl = async () => ({
    status: 200, ok: true, headers: new Headers(),
    text: async () => "<html>login page</html>"
  });
  await assert.rejects(
    () => fetchCalendarFeed("https://feeds.example/x", { resolve: publicDns, fetchImpl }),
    /ligner ikke en kalender/
  );
});

test("UTC shift times are converted to local wall-clock time", () => {
  // Summer: Copenhagen is UTC+2, so 13:00Z is a 15:00 start.
  const summer = parseScheduleFeed(calendar([
    shift({ start: "20260807T130000Z", end: "20260807T170000Z" })
  ]));
  assert.deepEqual(summer.shifts["2026-08-07"], { time: "15:00-19:00", source: "ukg" });

  // Winter: UTC+1, so the same 13:00Z is a 14:00 start.
  const winter = parseScheduleFeed(calendar([
    shift({ start: "20261207T130000Z", end: "20261207T170000Z" })
  ]));
  assert.deepEqual(winter.shifts["2026-12-07"], { time: "14:00-18:00", source: "ukg" });
});

test("a shift crossing midnight stays on the day it started", () => {
  const result = parseScheduleFeed(calendar([
    shift({ start: "20260807T200000Z", end: "20260808T000000Z" })
  ]));
  assert.deepEqual(result.shifts["2026-08-07"], { time: "22:00-02:00", source: "ukg" });
  assert.equal(result.shifts["2026-08-08"], undefined);
});

test("cancelled and all-day entries are not treated as shifts", () => {
  const result = parseScheduleFeed(calendar([
    shift({ start: "20260807T130000Z", end: "20260807T170000Z", status: "CANCELLED" }),
    "BEGIN:VEVENT\r\nSUMMARY:Ferie\r\nDTSTART;VALUE=DATE:20260810\r\nDTEND;VALUE=DATE:20260811\r\nEND:VEVENT",
    shift({ start: "20260812T060000Z", end: "20260812T100000Z" })
  ]));

  assert.deepEqual(Object.keys(result.shifts), ["2026-08-12"]);
  assert.equal(result.skipped.length, 1);
});

test("two shifts in one day become one span with the gap as unpaid break", () => {
  const result = parseScheduleFeed(calendar([
    shift({ start: "20260807T080000Z", end: "20260807T100000Z" }),
    shift({ start: "20260807T130000Z", end: "20260807T160000Z" })
  ]));

  // 10:00-12:00 and 15:00-18:00 local, so a 3 hour gap in a 10:00-18:00 span.
  assert.equal(result.shifts["2026-08-07"].time, "10:00-18:00");
  assert.equal(result.shifts["2026-08-07"].pauseOverride, 180);
  assert.equal(result.shifts["2026-08-07"].split, 2);
});

test("TZID and floating times are read as local wall-clock", () => {
  const result = parseScheduleFeed(calendar([
    shift({ start: "20260807T150000", end: "20260807T190000",
            extra: [], summary: "floating" }).replace(
      "DTSTART:20260807T150000", "DTSTART;TZID=Europe/Copenhagen:20260807T150000"
    ).replace("DTEND:20260807T190000", "DTEND;TZID=Europe/Copenhagen:20260807T190000")
  ]));
  assert.equal(result.shifts["2026-08-07"].time, "15:00-19:00");
});

test("folded lines are rejoined before parsing", () => {
  const folded = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "SUMMARY:Salling Group-Vagt med et meget langt navn der",
    " \tfortsaetter paa naeste linje",
    "DTSTART:20260807T130000Z",
    "DTEND:20260807T170000Z",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");

  const result = parseScheduleFeed(folded);
  assert.equal(result.shifts["2026-08-07"].time, "15:00-19:00");
});

test("the reported range covers exactly the imported dates", () => {
  const result = parseScheduleFeed(calendar([
    shift({ start: "20260807T130000Z", end: "20260807T170000Z" }),
    shift({ start: "20260913T080000Z", end: "20260913T110000Z" })
  ]));
  assert.equal(result.from, "2026-08-07");
  assert.equal(result.to, "2026-09-13");
});

test("an empty calendar yields nothing rather than throwing", () => {
  const result = parseScheduleFeed(calendar([]));
  assert.deepEqual(result.shifts, {});
  assert.equal(result.from, null);
});
