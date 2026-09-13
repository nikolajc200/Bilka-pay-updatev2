#!/usr/bin/env node
/**
 * Registers the /sync slash command with Discord. Run once, and again only if
 * the command's name, description or options change.
 *
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... node scripts/register-discord-commands.js
 *
 * The bot token is used only here and is never stored by the app — the running
 * server authenticates interactions with the public key instead.
 */
import { SYNC_COMMAND } from "../discord-interactions.js";

const applicationId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;

if (!applicationId || !token) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN first.");
  process.exit(1);
}

const response = await fetch(
  `https://discord.com/api/v10/applications/${applicationId}/commands`,
  {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${token}`
    },
    body: JSON.stringify([SYNC_COMMAND])
  }
);

const body = await response.text();
if (!response.ok) {
  console.error(`Discord rejected the registration (${response.status}):`);
  console.error(body);
  process.exit(1);
}

const commands = JSON.parse(body);
console.log(`Registered ${commands.length} command(s):`);
for (const command of commands) console.log(`  /${command.name} — ${command.description}`);
console.log("\nGlobal commands can take a few minutes to appear in Discord.");
