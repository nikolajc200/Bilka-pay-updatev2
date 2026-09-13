import { createPublicKey, randomBytes, verify } from "node:crypto";

export const INTERACTION_TYPE = { PING: 1, APPLICATION_COMMAND: 2 };
export const RESPONSE_TYPE = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5 };
export const EPHEMERAL = 64;

const LINK_CODE_TTL_MS = 10 * 60_000;
// SPKI wrapper for a raw 32-byte Ed25519 public key, so Node will import the
// bare hex string Discord hands out without pulling in a crypto library.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function discordPublicKey(publicKeyHex) {
  const raw = Buffer.from(String(publicKeyHex || ""), "hex");
  if (raw.length !== 32) throw new Error("Discord public key must be 32 bytes of hex");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki"
  });
}

/**
 * Discord signs `timestamp + body`. This must run against the raw bytes — any
 * parse-and-restringify changes the payload and the signature stops matching.
 */
export function verifyInteractionSignature({ rawBody, signature, timestamp, publicKey }) {
  if (!rawBody || !signature || !timestamp || !publicKey) return false;
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(String(signature), "hex");
  } catch {
    return false;
  }
  if (signatureBytes.length !== 64) return false;

  try {
    return verify(
      null,
      Buffer.concat([Buffer.from(String(timestamp), "utf8"), Buffer.from(rawBody, "utf8")]),
      publicKey,
      signatureBytes
    );
  } catch {
    return false;
  }
}

// Unambiguous characters only — this gets read off a screen and typed into chat.
export function generateLinkCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(6);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

export function linkCodeExpiry(now = Date.now()) {
  return new Date(now + LINK_CODE_TTL_MS).toISOString();
}

export function commandName(interaction) {
  return interaction?.data?.name ?? null;
}

export function optionValue(interaction, name) {
  const option = (interaction?.data?.options ?? []).find((entry) => entry.name === name);
  return option?.value ?? null;
}

// A command can arrive from a guild member or a DM; the id lives in different
// places depending on which.
export function interactionUserId(interaction) {
  return interaction?.member?.user?.id ?? interaction?.user?.id ?? null;
}

export function ephemeral(content) {
  return { type: RESPONSE_TYPE.MESSAGE, data: { content, flags: EPHEMERAL } };
}

export function deferredEphemeral() {
  return { type: RESPONSE_TYPE.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } };
}

/**
 * Discord expects an answer within three seconds, which a UKG round-trip can
 * easily exceed. So we defer, then edit the original reply once the work is
 * done — the interaction token is enough, no bot token needed.
 */
export async function editDeferredReply(applicationId, interactionToken, content, {
  fetchImpl = fetch
} = {}) {
  const url =
    `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`;
  const response = await fetchImpl(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(10_000)
  });
  return response.ok;
}

export const SYNC_COMMAND = {
  name: "sync",
  description: "Hent din vagtplan fra UKG med det samme",
  options: [
    {
      name: "kode",
      description: "Forbindelseskode fra Bilka Pay (kun første gang)",
      type: 3,
      required: false
    }
  ]
};
