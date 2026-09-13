import assert from "node:assert/strict";
import test from "node:test";
import {
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
} from "../auth.js";

test("passwords verify against their own hash and nothing else", async () => {
  const hash = await hashPassword("correct horse battery");

  assert.equal(await verifyPassword("correct horse battery", hash), true);
  assert.equal(await verifyPassword("Correct horse battery", hash), false);
  assert.equal(await verifyPassword("", hash), false);

  // Salted, so the same password never produces the same stored value twice.
  assert.notEqual(hash, await hashPassword("correct horse battery"));
});

test("malformed password hashes are rejected rather than throwing", async () => {
  for (const bad of ["", "not-a-hash", "scrypt$1$2$3", "bcrypt$16384$8$1$AA==$AA==", null]) {
    assert.equal(await verifyPassword("anything", bad), false);
  }
});

test("session tokens are random and stored only as hashes", () => {
  const first = createSessionToken();
  const second = createSessionToken();

  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash, hashSessionToken(first.token));
  assert.equal(first.tokenHash.length, 64);
  assert.ok(!first.tokenHash.includes(first.token));
});

test("usernames are normalized and validated", () => {
  assert.equal(normalizeUsername("  ROOT "), "root");
  assert.equal(validUsername("root"), true);
  assert.equal(validUsername("anna.b_1-x"), true);
  assert.equal(validUsername("A"), false);
  assert.equal(validUsername("has space"), false);
  assert.equal(validUsername("-leading"), false);
  assert.equal(validUsername("x".repeat(32)), false);
});

test("password policy explains why a password is refused", () => {
  assert.match(passwordProblem("short"), /mindst 10 tegn/);
  assert.equal(passwordProblem("a-long-enough-one"), null);
  assert.ok(passwordProblem("x".repeat(201)));
});

test("generated passwords avoid visually ambiguous characters", () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const password = generatePassword();
    assert.equal(password.length, 20);
    assert.doesNotMatch(password, /[O0Il1]/);
  }
});

test("session cookies are HttpOnly, and Secure only when asked", () => {
  const insecure = sessionCookie("abc", { secure: false });
  assert.match(insecure, /HttpOnly/);
  assert.match(insecure, /SameSite=Lax/);
  assert.doesNotMatch(insecure, /Secure/);

  assert.match(sessionCookie("abc", { secure: true }), /Secure/);
  assert.match(clearedSessionCookie({ secure: true }), /Max-Age=0/);
});

test("cookie parsing survives padding and missing values", () => {
  assert.deepEqual(parseCookies("a=1; b=2"), { a: "1", b: "2" });
  assert.deepEqual(parseCookies("  spaced =  value  "), { spaced: "value" });
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies("=novalue; ok=1"), { ok: "1" });
});
