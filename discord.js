const WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);
const SEND_TIMEOUT_MS = 10_000;

export class DiscordError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Webhooks are restricted to Discord's own hosts rather than merely "some
 * public https URL". It keeps this from being a general-purpose request
 * forwarder pointed at anything on the network.
 */
export function parseWebhookUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw new DiscordError("Ugyldig webhook-URL");
  }
  if (url.protocol !== "https:") {
    throw new DiscordError("Webhook-URL skal starte med https://");
  }
  if (!WEBHOOK_HOSTS.has(url.hostname)) {
    throw new DiscordError("Adressen er ikke en Discord webhook");
  }
  if (!/^\/api\/webhooks\/\d+\/[\w-]+$/.test(url.pathname)) {
    throw new DiscordError("Adressen ligner ikke en Discord webhook");
  }
  return url;
}

export function describeWebhook(url) {
  if (!url) return { configured: false };
  try {
    const parsed = new URL(url);
    // Only the channel-ish id, never the token half of the path.
    return { configured: true, id: parsed.pathname.split("/")[3] ?? null };
  } catch {
    return { configured: true, id: null };
  }
}

export async function sendDiscordMessage(webhookUrl, payload, { fetchImpl = fetch } = {}) {
  const url = parseWebhookUrl(webhookUrl);
  const response = await fetchImpl(url.href, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
  });

  if (response.status === 404 || response.status === 401) {
    throw new DiscordError("Webhooken findes ikke længere", 404);
  }
  if (response.status === 429) {
    throw new DiscordError("Discord bad om at vente (rate limit)", 429);
  }
  if (!response.ok) {
    throw new DiscordError(`Discord svarede med fejl ${response.status}`, 502);
  }
  return true;
}

const WEEKDAYS = ["søn", "man", "tir", "ons", "tor", "fre", "lør"];
const MONTHS = [
  "jan", "feb", "mar", "apr", "maj", "jun",
  "jul", "aug", "sep", "okt", "nov", "dec"
];

export function formatDanishDate(dateISO) {
  const [year, month, day] = String(dateISO).split("-").map(Number);
  if (!year || !month || !day) return dateISO;
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${day}. ${MONTHS[month - 1]}`;
}

export function buildScheduleChangeMessage({ added, updated, removed }) {
  const lines = [];
  for (const entry of added) lines.push(`+ ${formatDanishDate(entry.date)}  ${entry.time}`);
  for (const entry of updated) {
    lines.push(`~ ${formatDanishDate(entry.date)}  ${entry.was} → ${entry.time}`);
  }
  for (const entry of removed) {
    lines.push(`− ${formatDanishDate(entry.date)}  ${entry.time} (aflyst)`);
  }

  const counts = [];
  if (added.length) counts.push(`${added.length} ny${added.length === 1 ? "" : "e"}`);
  if (updated.length) counts.push(`${updated.length} ændret`);
  if (removed.length) counts.push(`${removed.length} fjernet`);

  return {
    content: [
      "📅 **Vagtplanen er opdateret**",
      counts.join(" · "),
      "```diff",
      // Discord truncates long messages, so cap it and say so.
      ...lines.slice(0, 25),
      ...(lines.length > 25 ? [`… og ${lines.length - 25} mere`] : []),
      "```"
    ].join("\n")
  };
}

export function buildMonthlyReminderMessage({ periodLabel, shifts, hours, pay, appUrl }) {
  const money = new Intl.NumberFormat("da-DK", {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
  const decimal = new Intl.NumberFormat("da-DK", {
    minimumFractionDigits: 1, maximumFractionDigits: 1
  });

  return {
    content: [
      "💰 **Månedsopsamling**",
      `Lønperiode: ${periodLabel}`,
      `${shifts} vagter · ${decimal.format(hours)} timer · ${money.format(pay)} DKK`,
      "",
      "Husk at tjekke regninger og opsparing.",
      appUrl || ""
    ].filter(Boolean).join("\n")
  };
}
