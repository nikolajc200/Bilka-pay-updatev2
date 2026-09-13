import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPlanStore } from "./plan-store.js";
import {
  DEFAULT_TIME_ZONE,
  ScheduleError,
  assertPublicHttpsUrl,
  fetchCalendarFeed,
  parseScheduleFeed
} from "./schedule.js";
import {
  buildScheduleChangeMessage,
  describeWebhook,
  parseWebhookUrl,
  sendDiscordMessage
} from "./discord.js";
import { startScheduler, syncUserSchedule } from "./jobs.js";
import {
  INTERACTION_TYPE,
  RESPONSE_TYPE,
  commandName,
  deferredEphemeral,
  discordPublicKey,
  editDeferredReply,
  ephemeral,
  generateLinkCode,
  interactionUserId,
  linkCodeExpiry,
  optionValue,
  verifyInteractionSignature
} from "./discord-interactions.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clearedSessionCookie,
  createSessionToken,
  generatePassword,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
  parseCookies,
  passwordProblem,
  sessionCookie,
  validUsername,
  verifyPassword
} from "./auth.js";

const defaultRoot = fileURLToPath(new URL(".", import.meta.url));
const maxBodyBytes = 1024 * 1024;

// Which files may be served, and what a request must prove to get them.
// "open" is everything the login page needs before a session exists.
const staticFiles = new Map([
  ["login.html", "open"],
  ["login.js", "open"],
  ["styles.css", "open"],
  ["assets/hvem-ka-bilka.png", "open"],
  ["assets/hvem-ka-bilka-header.png", "open"],
  ["index.html", "user"],
  ["app.js", "user"],
  ["calculator.js", "user"],
  ["schedule-merge.js", "user"],
  ["admin.html", "admin"],
  ["admin.js", "admin"]
]);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png"
};

class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function createRateLimiter({
  limit = 120,
  windowMs = 60_000,
  maxKeys = 10_000,
  clock = Date.now
} = {}) {
  const requests = new Map();

  function dropExpired(now) {
    for (const [key, entry] of requests) {
      if (entry.resetAt <= now) requests.delete(key);
    }
  }

  return {
    get size() {
      return requests.size;
    },
    check(key) {
      const now = clock();
      const current = requests.get(key);
      if (!current || current.resetAt <= now) {
        if (requests.size >= maxKeys) dropExpired(now);
        requests.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      current.count += 1;
      return current.count <= limit;
    }
  };
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function redirect(response, location, headers = {}) {
  response.writeHead(302, { Location: location, "Cache-Control": "no-store", ...headers });
  response.end();
}

function validState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const updatedAt = new Date(state.updatedAt);
  return typeof state.updatedAt === "string" && !Number.isNaN(updatedAt.getTime());
}

async function readBody(request) {
  // Requiring JSON means a cross-site <form> cannot reach these endpoints, which
  // together with SameSite=Lax on the session cookie is the CSRF defence.
  const contentType = String(request.headers["content-type"] || "");
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new RequestError("Expected application/json", 415);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new RequestError("Body too large", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError("Invalid JSON", 400);
  }
}

// Only consult forwarding headers when TRUST_PROXY is set. A client can send
// any header it likes, so trusting these unconditionally would let anyone
// sidestep the rate limit by rotating a fake X-Forwarded-For.
function requestAddress(request, trustProxy = false) {
  if (trustProxy) {
    const connectingIp = request.headers["cf-connecting-ip"];
    if (typeof connectingIp === "string" && connectingIp.trim()) {
      return connectingIp.trim();
    }
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      return forwarded.split(",")[0].trim();
    }
  }
  return request.socket.remoteAddress || "unknown";
}

// A Secure cookie is silently dropped by the browser over plain HTTP, so the
// flag has to track how this particular request arrived: HTTPS through the
// tunnel gets it, direct LAN access on http:// must not, or login cannot work
// there at all. COOKIE_SECURE forces it either way when that is wanted.
function requestIsHttps(request, trustProxy) {
  if (trustProxy) {
    const proto = request.headers["x-forwarded-proto"];
    if (typeof proto === "string" && proto.trim()) {
      return proto.split(",")[0].trim().toLowerCase() === "https";
    }
  }
  return Boolean(request.socket.encrypted);
}

function cookieIsSecure(request, context) {
  if (context.secureCookies === true || context.secureCookies === false) {
    return context.secureCookies;
  }
  return requestIsHttps(request, context.trustProxy);
}

async function authenticate(request, store) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const session = await store.findSession(tokenHash);
  if (!session) return null;
  return { user: session.user, tokenHash };
}

async function handleHealth(response, store) {
  try {
    await store.ping();
    return sendJson(response, 200, { ok: true, storage: store.kind });
  } catch (error) {
    console.error("Health check failed:", error.message);
    return sendJson(response, 503, { ok: false, error: "Storage unavailable" });
  }
}

async function handleLogin(request, response, context) {
  const { store, loginLimiter, trustProxy } = context;
  const body = await readBody(request);
  const username = normalizeUsername(body?.username);
  const password = String(body?.password ?? "");

  // Both counters must always be incremented, so check them before combining
  // rather than letting || short-circuit one away.
  const address = requestAddress(request, trustProxy);
  const ipAllowed = loginLimiter.check(`ip:${address}`);
  const userAllowed = loginLimiter.check(`user:${username}`);
  if (!ipAllowed || !userAllowed) {
    return sendJson(response, 429, { error: "For mange forsøg. Prøv igen om lidt." }, {
      "Retry-After": "900"
    });
  }

  const record = username ? await store.findUserByUsername(username) : null;
  // Always run a verify so a missing user and a wrong password take the same
  // time; otherwise response timing reveals which usernames exist.
  const storedHash = record?.password_hash ?? record?.passwordHash ?? "scrypt$16384$8$1$AA==$AA==";
  const passwordMatches = await verifyPassword(password, storedHash);

  if (!record || !passwordMatches || record.disabled) {
    return sendJson(response, 401, { error: "Forkert brugernavn eller adgangskode" });
  }

  const { token, tokenHash } = createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await store.createSession(record.id, tokenHash, expiresAt);
  await store.updateUser(record.id, { lastLoginAt: new Date().toISOString() });

  return sendJson(response, 200, {
    ok: true,
    mustChangePassword: Boolean(record.must_change_password ?? record.mustChangePassword),
    role: record.role
  }, { "Set-Cookie": sessionCookie(token, { secure: cookieIsSecure(request, context) }) });
}

async function handleLogout(request, response, context, session) {
  if (session) await context.store.deleteSession(session.tokenHash);
  return sendJson(response, 200, { ok: true }, {
    "Set-Cookie": clearedSessionCookie({ secure: cookieIsSecure(request, context) })
  });
}

async function handleChangePassword(request, response, context, session) {
  const body = await readBody(request);
  const currentPassword = String(body?.currentPassword ?? "");
  const newPassword = String(body?.newPassword ?? "");

  const problem = passwordProblem(newPassword);
  if (problem) return sendJson(response, 400, { error: problem });

  const record = await context.store.findUserById(session.user.id);
  const storedHash = record?.password_hash ?? record?.passwordHash;
  if (!record || !(await verifyPassword(currentPassword, storedHash))) {
    return sendJson(response, 401, { error: "Nuværende adgangskode er forkert" });
  }
  if (await verifyPassword(newPassword, storedHash)) {
    return sendJson(response, 400, { error: "Vælg en anden adgangskode end den nuværende" });
  }

  await context.store.updateUser(record.id, {
    passwordHash: await hashPassword(newPassword),
    mustChangePassword: false
  });
  // Every other device is signed out; the current one gets a fresh session.
  await context.store.deleteUserSessions(record.id);

  const { token, tokenHash } = createSessionToken();
  await context.store.createSession(
    record.id,
    tokenHash,
    new Date(Date.now() + SESSION_TTL_MS).toISOString()
  );
  return sendJson(response, 200, { ok: true }, {
    "Set-Cookie": sessionCookie(token, { secure: cookieIsSecure(request, context) })
  });
}

async function handlePlan(request, response, context, session) {
  const { store } = context;
  const userId = session.user.id;

  if (request.method === "GET") {
    try {
      const saved = await store.loadPlan(userId);
      if (!saved) return sendJson(response, 404, { error: "Ingen plan gemt endnu" });
      return sendJson(response, 200, saved);
    } catch (error) {
      console.error("Could not load plan:", error.message);
      return sendJson(response, 503, { error: "Database temporarily unavailable" });
    }
  }

  if (request.method === "PUT") {
    const body = await readBody(request);
    if (!validState(body?.state)) {
      return sendJson(response, 400, { error: "Invalid plan data" });
    }
    try {
      const result = await store.savePlan(userId, body.state);
      if (!result.saved) {
        return sendJson(response, 200, { ok: true, conflict: true, ...result.current });
      }
      return sendJson(response, 200, { ok: true, savedAt: result.current.savedAt });
    } catch (error) {
      console.error("Could not save plan:", error.message);
      return sendJson(response, 503, { error: "Database temporarily unavailable" });
    }
  }

  response.writeHead(405, { Allow: "GET, PUT" });
  response.end();
}

// Never echo the stored URL back in full — it is a bearer token for the whole
// schedule, and it only ever needs to be confirmed as present, not re-read.
function describeScheduleUrl(url) {
  if (!url) return { configured: false };
  try {
    return { configured: true, host: new URL(url).host };
  } catch {
    return { configured: true, host: null };
  }
}

async function handleSchedule(request, response, context, session) {
  const { store } = context;
  const userId = session.user.id;

  if (request.method === "GET") {
    return sendJson(response, 200, describeScheduleUrl(await store.getScheduleUrl(userId)));
  }

  if (request.method === "PUT") {
    const body = await readBody(request);
    const raw = String(body?.url ?? "").trim();

    if (!raw) {
      await store.updateUser(userId, { scheduleUrl: null });
      return sendJson(response, 200, { configured: false });
    }
    try {
      await assertPublicHttpsUrl(raw);
    } catch (error) {
      return sendJson(response, error.status || 400, { error: error.message });
    }
    await store.updateUser(userId, { scheduleUrl: raw });
    return sendJson(response, 200, describeScheduleUrl(raw));
  }

  response.writeHead(405, { Allow: "GET, PUT" });
  response.end();
}

async function handleScheduleShifts(request, response, context, session) {
  const url = await context.store.getScheduleUrl(session.user.id);
  if (!url) return sendJson(response, 404, { error: "Ingen kalender-URL gemt" });

  try {
    const feed = await fetchCalendarFeed(url);
    const parsed = parseScheduleFeed(feed, { timeZone: context.timeZone });
    return sendJson(response, 200, {
      shifts: parsed.shifts,
      from: parsed.from,
      to: parsed.to,
      skipped: parsed.skipped.length,
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    if (error instanceof ScheduleError) {
      return sendJson(response, error.status, { error: error.message });
    }
    console.error("Could not fetch schedule:", error.message);
    return sendJson(response, 502, { error: "Kunne ikke hente vagtplanen" });
  }
}

async function readRawBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new RequestError("Body too large", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Public endpoint — Discord calls it, so there is no session. The Ed25519
 * signature over the raw body is the authentication, and an unsigned or
 * badly-signed request must get 401 or Discord will not accept the URL.
 */
async function handleInteractions(request, response, context) {
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" });
    return response.end();
  }
  if (!context.discordPublicKey) {
    return sendJson(response, 503, { error: "Discord interactions not configured" });
  }

  const rawBody = await readRawBody(request);
  const valid = verifyInteractionSignature({
    rawBody,
    signature: request.headers["x-signature-ed25519"],
    timestamp: request.headers["x-signature-timestamp"],
    publicKey: context.discordPublicKey
  });
  if (!valid) {
    response.writeHead(401, { "Content-Type": "text/plain" });
    return response.end("invalid request signature");
  }

  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return sendJson(response, 400, { error: "Invalid JSON" });
  }

  if (interaction.type === INTERACTION_TYPE.PING) {
    return sendJson(response, 200, { type: RESPONSE_TYPE.PONG });
  }
  if (interaction.type !== INTERACTION_TYPE.APPLICATION_COMMAND) {
    return sendJson(response, 200, ephemeral("Den kommando kender jeg ikke."));
  }
  if (commandName(interaction) !== "sync") {
    return sendJson(response, 200, ephemeral("Ukendt kommando."));
  }

  // Answer inside Discord's three-second budget, then do the slow part.
  sendJson(response, 200, deferredEphemeral());
  runSyncCommand(interaction, context).catch((error) => {
    console.error("Discord /sync failed:", error.message);
  });
  return undefined;
}

async function runSyncCommand(interaction, context) {
  const { store, timeZone, discordApplicationId } = context;
  const discordUserId = interactionUserId(interaction);
  const code = String(optionValue(interaction, "kode") || "").trim().toUpperCase();

  const reply = (content) =>
    editDeferredReply(discordApplicationId, interaction.token, content);

  let user = discordUserId ? await store.findUserByDiscordId(discordUserId) : null;

  if (!user) {
    if (!code) {
      return reply(
        "Din Discord-konto er ikke forbundet endnu.\n"
        + "Åbn Bilka Pay → Indstillinger → Discord-beskeder → **Forbind Discord**, "
        + "og kør så `/sync kode:DIN-KODE`."
      );
    }
    const candidate = await store.findUserByLinkCode(code);
    if (!candidate) return reply("Koden er forkert eller udløbet. Lav en ny i Bilka Pay.");

    await store.updateUser(candidate.id, {
      discordUserId: String(discordUserId),
      // Single use: burn the code as soon as it works.
      discordLinkCode: null,
      discordLinkExpires: null
    });
    user = candidate;
  }

  const scheduleUrl = await store.getScheduleUrl(user.id);
  if (!scheduleUrl) return reply("Der er ingen UKG kalender-URL gemt på din konto endnu.");

  try {
    const result = await syncUserSchedule(store, {
      id: String(user.id),
      username: user.username,
      scheduleUrl
    }, { timeZone });

    if (result?.skipped === "no-plan") {
      return reply("Åbn Bilka Pay én gang først, så din plan findes på serveren.");
    }
    if (!result?.changed) {
      const count = Object.keys(result?.parsed?.shifts ?? {}).length;
      return reply(`✅ Vagtplanen er allerede opdateret (${count} vagter).`);
    }
    return reply(buildScheduleChangeMessage(result).content);
  } catch (error) {
    return reply(`Kunne ikke hente vagtplanen: ${error.message}`);
  }
}

async function handleDiscord(request, response, context, session) {
  const { store } = context;
  const userId = session.user.id;

  if (request.method === "GET") {
    return sendJson(response, 200, describeWebhook(await store.getDiscordWebhook(userId)));
  }

  if (request.method === "PUT") {
    const body = await readBody(request);
    const raw = String(body?.url ?? "").trim();

    if (!raw) {
      await store.updateUser(userId, { discordWebhook: null });
      return sendJson(response, 200, { configured: false });
    }
    try {
      parseWebhookUrl(raw);
    } catch (error) {
      return sendJson(response, error.status || 400, { error: error.message });
    }
    await store.updateUser(userId, { discordWebhook: raw });
    return sendJson(response, 200, describeWebhook(raw));
  }

  if (request.method === "POST" && context.wantsLinkCode) {
    const code = generateLinkCode();
    await store.updateUser(userId, {
      discordLinkCode: code,
      discordLinkExpires: linkCodeExpiry()
    });
    return sendJson(response, 200, { code, expiresInMinutes: 10 });
  }

  if (request.method === "POST") {
    const webhook = await store.getDiscordWebhook(userId);
    if (!webhook) return sendJson(response, 404, { error: "Ingen webhook gemt" });
    try {
      await sendDiscordMessage(webhook, {
        content: "✅ **Bilka Pay** er forbundet. Du får besked her når vagtplanen ændrer sig."
      });
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      return sendJson(response, error.status || 502, { error: error.message });
    }
  }

  response.writeHead(405, { Allow: "GET, PUT, POST" });
  response.end();
}

async function handleAdminUsers(request, response, context, session) {
  const { store } = context;

  if (request.method === "GET") {
    return sendJson(response, 200, { users: await store.listUsers() });
  }

  if (request.method === "POST") {
    const body = await readBody(request);
    const username = normalizeUsername(body?.username);
    const role = body?.role === "admin" ? "admin" : "user";

    if (!validUsername(username)) {
      return sendJson(response, 400, {
        error: "Brugernavn skal være 2-31 tegn: a-z, 0-9, punktum, bindestreg eller underscore"
      });
    }

    const password = generatePassword();
    try {
      const user = await store.createUser({
        username,
        passwordHash: await hashPassword(password),
        role,
        mustChangePassword: true
      });
      // The only time this password is ever readable — it is stored hashed.
      return sendJson(response, 201, { user, password });
    } catch (error) {
      if (error.code === "USERNAME_TAKEN") {
        return sendJson(response, 409, { error: "Brugernavnet findes allerede" });
      }
      throw error;
    }
  }

  response.writeHead(405, { Allow: "GET, POST" });
  response.end();
}

async function handleAdminUser(request, response, context, session, userId, action) {
  const { store } = context;
  const target = await store.findUserById(userId);
  if (!target) return sendJson(response, 404, { error: "Brugeren findes ikke" });

  const targetId = String(target.id);
  const isSelf = targetId === String(session.user.id);
  const targetIsAdmin = target.role === "admin";
  const targetDisabled = Boolean(target.disabled);

  // Guard rails so the instance can never be left without a way in.
  async function wouldRemoveLastAdmin() {
    if (!targetIsAdmin || targetDisabled) return false;
    return (await store.countAdmins()) <= 1;
  }

  if (action === "reset-password" && request.method === "POST") {
    const password = generatePassword();
    await store.updateUser(targetId, {
      passwordHash: await hashPassword(password),
      mustChangePassword: true
    });
    await store.deleteUserSessions(targetId);
    return sendJson(response, 200, { ok: true, password });
  }

  if (action === "revoke" && request.method === "POST") {
    await store.deleteUserSessions(targetId);
    return sendJson(response, 200, { ok: true });
  }

  if (!action && request.method === "PATCH") {
    const body = await readBody(request);
    const patch = {};

    if (body?.role === "admin" || body?.role === "user") {
      if (body.role === "user" && await wouldRemoveLastAdmin()) {
        return sendJson(response, 409, { error: "Der skal være mindst én aktiv administrator" });
      }
      patch.role = body.role;
    }

    if (typeof body?.disabled === "boolean") {
      if (isSelf && body.disabled) {
        return sendJson(response, 409, { error: "Du kan ikke deaktivere din egen konto" });
      }
      if (body.disabled && await wouldRemoveLastAdmin()) {
        return sendJson(response, 409, { error: "Der skal være mindst én aktiv administrator" });
      }
      patch.disabled = body.disabled;
    }

    const updated = await store.updateUser(targetId, patch);
    if (patch.disabled) await store.deleteUserSessions(targetId);
    return sendJson(response, 200, { user: updated });
  }

  if (!action && request.method === "DELETE") {
    if (isSelf) return sendJson(response, 409, { error: "Du kan ikke slette din egen konto" });
    if (await wouldRemoveLastAdmin()) {
      return sendJson(response, 409, { error: "Der skal være mindst én aktiv administrator" });
    }
    await store.deleteUser(targetId);
    return sendJson(response, 200, { ok: true });
  }

  response.writeHead(405, { Allow: "PATCH, DELETE, POST" });
  response.end();
}

async function serveStatic(request, response, context, session, pathnameOverride) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = pathnameOverride ?? url.pathname;
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "").replaceAll("\\", "/");

  const requirement = staticFiles.get(safePath);
  if (!requirement) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return response.end("Not found");
  }

  if (requirement !== "open" && !session) {
    // Send people to the login page rather than a bare 401 they cannot act on.
    return redirect(response, "/login");
  }
  if (requirement === "admin" && session.user.role !== "admin") {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return response.end("Forbidden");
  }
  if (requirement !== "open" && session.user.mustChangePassword && safePath !== "login.html") {
    return redirect(response, "/login?change=1");
  }

  const file = join(context.root, safePath);
  try {
    const fileInfo = await stat(file);
    if (!fileInfo.isFile()) throw new Error("Not a file");

    // Code and markup revalidate on every load. Relying on a hand-edited "?v="
    // meant a stale app.js could be paired with a fresh index.html, and the
    // mismatch throws on the first missing element — killing everything after
    // it. The ETag keeps that cheap: unchanged files still answer 304.
    const extension = extname(file);
    const immutableAsset = extension === ".png";
    const etag = `"${fileInfo.size.toString(16)}-${Math.floor(fileInfo.mtimeMs).toString(16)}"`;

    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
      return response.end();
    }

    response.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream",
      "Content-Length": fileInfo.size,
      ETag: etag,
      "Cache-Control": immutableAsset ? "public, max-age=300" : "no-cache"
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

export function createAppServer({
  store,
  root = defaultRoot,
  rateLimiter = createRateLimiter(),
  loginLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 }),
  scheduleLimiter = createRateLimiter({ limit: 20, windowMs: 60 * 60_000 }),
  trustProxy = false,
  secureCookies = "auto",
  timeZone = DEFAULT_TIME_ZONE,
  discordPublicKeyHex = "",
  discordApplicationId = ""
}) {
  let publicKey = null;
  if (discordPublicKeyHex) {
    try {
      publicKey = discordPublicKey(discordPublicKeyHex);
    } catch (error) {
      console.error("Ignoring DISCORD_PUBLIC_KEY:", error.message);
    }
  }

  const context = {
    store, root, rateLimiter, loginLimiter, scheduleLimiter,
    trustProxy, secureCookies, timeZone,
    discordPublicKey: publicKey,
    discordApplicationId
  };

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      const path = url.pathname;

      if (path === "/healthz") return handleHealth(response, store);

      const session = await authenticate(request, store);

      if (path === "/api/login" && request.method === "POST") {
        return await handleLogin(request, response, context);
      }
      if (path === "/api/logout" && request.method === "POST") {
        return await handleLogout(request, response, context, session);
      }
      // Signature-authenticated, so it sits ahead of the session gate.
      if (path === "/api/discord/interactions") {
        return await handleInteractions(request, response, context);
      }

      if (path === "/login") {
        if (session && !session.user.mustChangePassword) return redirect(response, "/");
        return await serveStatic(request, response, context, session, "/login.html");
      }
      if (path === "/admin") {
        return await serveStatic(request, response, context, session, "/admin.html");
      }

      if (path.startsWith("/api/")) {
        if (!session) return sendJson(response, 401, { error: "Ikke logget ind" });

        if (path === "/api/me") {
          return sendJson(response, 200, { user: session.user });
        }
        if (path === "/api/password" && request.method === "POST") {
          return await handleChangePassword(request, response, context, session);
        }

        // Until the password is changed, nothing else is reachable.
        if (session.user.mustChangePassword) {
          return sendJson(response, 403, {
            error: "Adgangskoden skal skiftes først",
            code: "PASSWORD_CHANGE_REQUIRED"
          });
        }

        if (path === "/api/plan") {
          if (!context.rateLimiter.check(requestAddress(request, trustProxy))) {
            return sendJson(response, 429, { error: "Too many requests" }, { "Retry-After": "60" });
          }
          return await handlePlan(request, response, context, session);
        }

        if (path === "/api/schedule") {
          return await handleSchedule(request, response, context, session);
        }
        if (path === "/api/discord") {
          return await handleDiscord(request, response, context, session);
        }
        if (path === "/api/discord/link") {
          return await handleDiscord(request, response, { ...context, wantsLinkCode: true }, session);
        }
        if (path === "/api/schedule/shifts" && request.method === "GET") {
          // Each call reaches out to an external server, so it gets a much
          // tighter budget than the plan endpoints.
          if (!context.scheduleLimiter.check(`schedule:${session.user.id}`)) {
            return sendJson(response, 429, { error: "For mange kalenderopslag" }, {
              "Retry-After": "60"
            });
          }
          return await handleScheduleShifts(request, response, context, session);
        }

        if (path.startsWith("/api/admin/")) {
          if (session.user.role !== "admin") {
            return sendJson(response, 403, { error: "Kræver administrator" });
          }
          if (path === "/api/admin/users") {
            return await handleAdminUsers(request, response, context, session);
          }
          const match = path.match(/^\/api\/admin\/users\/([^/]+)(?:\/([a-z-]+))?$/);
          if (match) {
            return await handleAdminUser(
              request, response, context, session, decodeURIComponent(match[1]), match[2]
            );
          }
        }

        return sendJson(response, 404, { error: "Ukendt endpoint" });
      }

      return await serveStatic(request, response, context, session);
    } catch (error) {
      if (error instanceof RequestError) {
        return sendJson(response, error.status, { error: error.message });
      }
      console.error("Unexpected request error:", error.message);
      return sendJson(response, 500, { error: "Unexpected server error" });
    }
  });
}

// Creates the first admin so a fresh deployment is reachable. The password is
// printed once and must be changed at first login, so it is never stored here.
export async function bootstrapRootUser(store, { log = console.log } = {}) {
  const users = await store.listUsers();
  if (users.length) return null;

  const password = generatePassword();
  await store.createUser({
    username: "root",
    passwordHash: await hashPassword(password),
    role: "admin",
    mustChangePassword: true
  });

  log("");
  log("=".repeat(64));
  log("  Bilka Pay: created the first administrator account");
  log("");
  log("    username: root");
  log(`    password: ${password}`);
  log("");
  log("  You must change this password at first login.");
  log("  It is stored only as a hash and cannot be shown again.");
  log("=".repeat(64));
  log("");
  return { username: "root", password };
}

export async function startServer({ env = process.env, root = defaultRoot } = {}) {
  const port = Number(env.PORT) || 4173;
  const host = env.HOST || "127.0.0.1";
  const trustProxy = env.TRUST_PROXY === "true";
  // "auto" decides per request from X-Forwarded-Proto, so the same instance
  // works over the HTTPS tunnel and over plain HTTP on the LAN.
  const secureCookies = env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : "auto";

  const store = await createPlanStore({ dataDir: join(root, "data"), env });
  await bootstrapRootUser(store);

  const timeZone = env.TIME_ZONE || DEFAULT_TIME_ZONE;
  const server = createAppServer({
    store, root, trustProxy, secureCookies, timeZone,
    discordPublicKeyHex: env.DISCORD_PUBLIC_KEY || "",
    discordApplicationId: env.DISCORD_APPLICATION_ID || ""
  });

  const stopScheduler = startScheduler(store, {
    timeZone,
    appUrl: env.APP_URL || "",
    hour: Number(env.DAILY_JOB_HOUR ?? 7)
  });

  server.on("close", () => {
    stopScheduler();
    store.close();
  });
  server.listen(port, host, () => {
    const storage = env.DATABASE_URL ? "PostgreSQL" : "local file fallback";
    console.log(`Bilka Pay running at http://${host}:${port} using ${storage}`);
  });
  return { server, store };
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  startServer().catch((error) => {
    console.error("Bilka Pay could not start:", error.message);
    process.exitCode = 1;
  });
}
