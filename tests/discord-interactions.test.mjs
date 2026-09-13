import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  SYNC_COMMAND,
  commandName,
  discordPublicKey,
  generateLinkCode,
  interactionUserId,
  linkCodeExpiry,
  optionValue,
  verifyInteractionSignature
} from "../discord-interactions.js";

// Stands in for Discord: sign with a private key, verify with the raw public
// hex exactly as Discord publishes it.
function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "jwk" });
  const hex = Buffer.from(raw.x, "base64url").toString("hex");
  return { privateKey, publicKeyHex: hex, imported: discordPublicKey(hex) };
}

function signPayload(privateKey, timestamp, body) {
  return sign(null, Buffer.from(timestamp + body, "utf8"), privateKey).toString("hex");
}

test("a correctly signed interaction verifies", () => {
  const { privateKey, imported } = keyPair();
  const body = JSON.stringify({ type: 1 });
  const timestamp = "1754250000";

  assert.equal(verifyInteractionSignature({
    rawBody: body,
    signature: signPayload(privateKey, timestamp, body),
    timestamp,
    publicKey: imported
  }), true);
});

test("tampering with body, timestamp or signature fails verification", () => {
  const { privateKey, imported } = keyPair();
  const body = JSON.stringify({ type: 2, data: { name: "sync" } });
  const timestamp = "1754250000";
  const signature = signPayload(privateKey, timestamp, body);

  const base = { rawBody: body, signature, timestamp, publicKey: imported };
  assert.equal(verifyInteractionSignature(base), true);

  // Re-serialising JSON changes the bytes, which is why the raw body matters.
  assert.equal(verifyInteractionSignature({
    ...base, rawBody: JSON.stringify(JSON.parse(body)) + " "
  }), false);
  assert.equal(verifyInteractionSignature({ ...base, timestamp: "1754250001" }), false);
  assert.equal(verifyInteractionSignature({ ...base, signature: "00".repeat(64) }), false);
  assert.equal(verifyInteractionSignature({ ...base, signature: "not-hex" }), false);
  assert.equal(verifyInteractionSignature({ ...base, signature: "abcd" }), false);
});

test("a signature from a different key is rejected", () => {
  const alice = keyPair();
  const mallory = keyPair();
  const body = JSON.stringify({ type: 1 });
  const timestamp = "1754250000";

  assert.equal(verifyInteractionSignature({
    rawBody: body,
    signature: signPayload(mallory.privateKey, timestamp, body),
    timestamp,
    publicKey: alice.imported
  }), false);
});

test("missing pieces never verify", () => {
  const { imported } = keyPair();
  for (const patch of [
    { rawBody: "" }, { signature: "" }, { timestamp: "" }, { publicKey: null }
  ]) {
    assert.equal(verifyInteractionSignature({
      rawBody: "{}", signature: "00".repeat(64), timestamp: "1", publicKey: imported, ...patch
    }), false);
  }
});

test("a malformed public key is refused rather than silently accepted", () => {
  assert.throws(() => discordPublicKey("abcd"), /32 bytes/);
  assert.throws(() => discordPublicKey(""), /32 bytes/);
});

test("link codes are unambiguous and expire", () => {
  const codes = new Set();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = generateLinkCode();
    assert.equal(code.length, 6);
    assert.doesNotMatch(code, /[O0I1]/);
    codes.add(code);
  }
  assert.ok(codes.size > 40, "codes should not repeat much");

  const expiry = new Date(linkCodeExpiry(Date.parse("2026-08-03T12:00:00Z")));
  assert.equal(expiry.toISOString(), "2026-08-03T12:10:00.000Z");
});

test("command name, options and user id are read from either DM or guild shape", () => {
  const guild = {
    data: { name: "sync", options: [{ name: "kode", value: "ABC123" }] },
    member: { user: { id: "111" } }
  };
  const dm = { data: { name: "sync" }, user: { id: "222" } };

  assert.equal(commandName(guild), "sync");
  assert.equal(optionValue(guild, "kode"), "ABC123");
  assert.equal(optionValue(dm, "kode"), null);
  assert.equal(interactionUserId(guild), "111");
  assert.equal(interactionUserId(dm), "222");
  assert.equal(interactionUserId({}), null);
});

test("the registered command shape is what Discord expects", () => {
  assert.equal(SYNC_COMMAND.name, "sync");
  assert.ok(SYNC_COMMAND.description.length > 0);
  const [option] = SYNC_COMMAND.options;
  assert.equal(option.name, "kode");
  assert.equal(option.type, 3, "string option");
  assert.equal(option.required, false, "plain /sync must work once linked");
});
