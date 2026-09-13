import { lookup } from "node:dns/promises";
import net from "node:net";

export const DEFAULT_TIME_ZONE = "Europe/Copenhagen";
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

class ScheduleError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export { ScheduleError };

// The server sits on the same LAN as Proxmox, Jellyfin and the *arr stack, so a
// user-supplied "go fetch this URL" is a genuine SSRF hole unless every address
// it resolves to is checked — including after each redirect.
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const value = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (value === "::1" || value === "::") return true;
    if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) return true;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

export async function assertPublicHttpsUrl(rawUrl, { resolve = lookup } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new ScheduleError("Ugyldig URL");
  }
  if (url.protocol !== "https:") {
    throw new ScheduleError("Kalender-URL skal starte med https://");
  }

  let addresses;
  try {
    addresses = await resolve(url.hostname, { all: true });
  } catch {
    throw new ScheduleError("Kunne ikke slå værtsnavnet op");
  }
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new ScheduleError("Den adresse peger på et internt netværk og blev afvist", 403);
  }
  return url;
}

export async function fetchCalendarFeed(rawUrl, { resolve = lookup, fetchImpl = fetch } = {}) {
  let target = await assertPublicHttpsUrl(rawUrl, { resolve });

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(target.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "text/calendar, text/plain" }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new ScheduleError("Kalenderen svarede med en ugyldig omdirigering");
      // Re-validate every hop, or one redirect defeats the whole check.
      target = await assertPublicHttpsUrl(new URL(location, target).href, { resolve });
      continue;
    }

    if (!response.ok) {
      throw new ScheduleError(`Kalenderen svarede med fejl ${response.status}`, 502);
    }

    const body = await response.text();
    if (body.length > MAX_FEED_BYTES) {
      throw new ScheduleError("Kalenderen er for stor", 502);
    }
    if (!body.includes("BEGIN:VCALENDAR")) {
      throw new ScheduleError("Svaret ligner ikke en kalender (.ics)", 502);
    }
    return body;
  }

  throw new ScheduleError("For mange omdirigeringer");
}

function formatterFor(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
}

function wallPartsInZone(instant, formatter) {
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value])
  );
  // Intl renders midnight as 24 in some environments.
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
    minutes: Number(hour) * 60 + Number(parts.minute)
  };
}

// Converts a wall-clock reading in `timeZone` to the UTC instant it refers to.
// Two passes settle the DST cases where the first guess lands on the wrong side
// of a transition.
function zonedWallTimeToInstant({ year, month, day, hour, minute }, timeZone) {
  const formatter = formatterFor(timeZone);
  const targetMinutes = Date.UTC(year, month - 1, day, hour, minute) / 60_000;
  let instant = new Date(Date.UTC(year, month - 1, day, hour, minute));

  for (let pass = 0; pass < 2; pass += 1) {
    const seen = wallPartsInZone(instant, formatter);
    const [seenYear, seenMonth, seenDay] = seen.date.split("-").map(Number);
    const seenMinutes = Date.UTC(seenYear, seenMonth - 1, seenDay, 0, 0) / 60_000 + seen.minutes;
    const drift = seenMinutes - targetMinutes;
    if (drift === 0) break;
    instant = new Date(instant.getTime() - drift * 60_000);
  }
  return instant;
}

function parseIcsDate(raw, parameters, timeZone) {
  const value = raw.trim();

  const utc = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (utc) {
    const [, y, mo, d, h, mi, s] = utc.map(Number);
    return { instant: new Date(Date.UTC(y, mo - 1, d, h, mi, s)), allDay: false };
  }

  const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    return { allDay: true };
  }

  const floating = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (floating) {
    const [, y, mo, d, h, mi] = floating.map(Number);
    // A TZID names the zone the wall time belongs to; without one it is
    // "floating" and interpreted in the viewer's zone, which for us is theirs.
    const zone = parameters.TZID && parameters.TZID !== "UTC" ? parameters.TZID : timeZone;
    let instant;
    try {
      instant = zonedWallTimeToInstant({ year: y, month: mo, day: d, hour: h, minute: mi }, zone);
    } catch {
      instant = zonedWallTimeToInstant({ year: y, month: mo, day: d, hour: h, minute: mi }, timeZone);
    }
    return { instant, allDay: false };
  }

  return { unparsed: true };
}

function unfold(ics) {
  // RFC 5545 folds long lines by starting the continuation with a space or tab.
  return String(ics).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function readProperty(block, name) {
  const match = block.match(new RegExp(`^${name}((?:;[^:\\n]*)?):(.*)$`, "m"));
  if (!match) return null;
  const parameters = {};
  for (const part of match[1].split(";")) {
    const [key, ...rest] = part.split("=");
    if (key && rest.length) parameters[key.toUpperCase()] = rest.join("=");
  }
  return { parameters, value: match[2] };
}

/**
 * Turns an iCalendar feed into `{ "YYYY-MM-DD": { time: "HH:MM-HH:MM", ... } }`
 * in the given zone. Shifts crossing midnight stay on their starting date,
 * which is how the planner already stores them.
 */
export function parseScheduleFeed(ics, { timeZone = DEFAULT_TIME_ZONE } = {}) {
  const formatter = formatterFor(timeZone);
  const blocks = unfold(ics).split("BEGIN:VEVENT").slice(1);
  const byDate = new Map();
  const skipped = [];

  for (const block of blocks) {
    const body = block.split("END:VEVENT")[0];
    const start = readProperty(body, "DTSTART");
    const end = readProperty(body, "DTEND");
    const summary = readProperty(body, "SUMMARY")?.value?.trim() || "";
    const status = readProperty(body, "STATUS")?.value?.trim().toUpperCase();

    if (status === "CANCELLED") continue;
    if (!start || !end) {
      skipped.push(summary || "ukendt begivenhed");
      continue;
    }

    const from = parseIcsDate(start.value, start.parameters, timeZone);
    const to = parseIcsDate(end.value, end.parameters, timeZone);
    // All-day entries are absences and holidays, not shifts with hours.
    if (from.allDay || to.allDay || from.unparsed || to.unparsed) {
      skipped.push(summary || "heldagsbegivenhed");
      continue;
    }

    const startLocal = wallPartsInZone(from.instant, formatter);
    const endLocal = wallPartsInZone(to.instant, formatter);
    if (to.instant <= from.instant) {
      skipped.push(summary || "begivenhed uden varighed");
      continue;
    }

    const existing = byDate.get(startLocal.date);
    if (!existing) {
      byDate.set(startLocal.date, {
        start: from.instant,
        end: to.instant,
        startTime: startLocal.time,
        endTime: endLocal.time,
        summary,
        parts: 1
      });
      continue;
    }

    // The planner stores one shift per day. A split shift becomes the whole
    // span with the gap booked as an unpaid break, so paid hours stay right.
    const earliest = from.instant < existing.start ? from.instant : existing.start;
    const latest = to.instant > existing.end ? to.instant : existing.end;
    const workedMs = (existing.end - existing.start) + (to.instant - from.instant);
    const gapMinutes = Math.max(0, Math.round((latest - earliest - workedMs) / 60_000));

    byDate.set(startLocal.date, {
      start: earliest,
      end: latest,
      startTime: wallPartsInZone(earliest, formatter).time,
      endTime: wallPartsInZone(latest, formatter).time,
      summary: existing.summary,
      parts: existing.parts + 1,
      gapMinutes
    });
  }

  const shifts = {};
  for (const [date, entry] of [...byDate.entries()].sort()) {
    shifts[date] = {
      time: `${entry.startTime}-${entry.endTime}`,
      source: "ukg",
      ...(entry.parts > 1 ? { pauseOverride: entry.gapMinutes, split: entry.parts } : {})
    };
  }

  const dates = Object.keys(shifts);
  return {
    shifts,
    skipped,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null
  };
}
