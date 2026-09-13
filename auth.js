import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

// 16384 * 8 * 128 = 16 MiB per hash, which stays under Node's 32 MiB scrypt
// default and takes ~100ms here — slow enough to matter for guessing, fast
// enough that a login does not feel laggy.
const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 64 };
export const SESSION_COOKIE = "bp_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const PASSWORD_MIN_LENGTH = 10;
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,30})$/;

export function normalizeUsername(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function validUsername(value) {
  return USERNAME_PATTERN.test(normalizeUsername(value));
}

// Returned to the caller so the UI can explain *why* a password was rejected.
export function passwordProblem(value) {
  const password = String(value ?? "");
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Adgangskoden skal være mindst ${PASSWORD_MIN_LENGTH} tegn`;
  }
  if (password.length > 200) return "Adgangskoden er for lang";
  return null;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p
  });
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    derived.toString("base64")
  ].join("$");
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltB64, expectedB64] = parts;
  const expected = Buffer.from(expectedB64, "base64");
  let derived;
  try {
    derived = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p)
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function createSessionToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

// Sessions are stored hashed so a leaked database does not hand out live logins.
export function hashSessionToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

// Readable but unambiguous: no O/0, I/1 confusion when typing it off a screen.
export function generatePassword(length = 20) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(length);
  let password = "";
  for (let index = 0; index < length; index += 1) {
    password += alphabet[bytes[index] % alphabet.length];
  }
  return password;
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      cookies[name] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

export function sessionCookie(token, { secure, maxAgeMs = SESSION_TTL_MS } = {}) {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearedSessionCookie({ secure } = {}) {
  const attributes = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}
