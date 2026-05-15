#!/usr/bin/env node

const HELP_FLAGS = new Set(["-h", "--help"]);

if (process.argv.slice(2).some((arg) => HELP_FLAGS.has(arg))) {
  printHelp();
  process.exit(0);
}

if (process.env.HYDRA_ALLOW_DISCORD_COMMAND_SYNC !== "1") {
  fail(
    "Refusing to sync Discord commands without HYDRA_ALLOW_DISCORD_COMMAND_SYNC=1. " +
      "This guard exists to prevent accidental production Discord app changes."
  );
}

const authServerUrl = requiredEnv("AUTH_SERVER_URL");
const adminSecret = requiredEnv("DISCORD_COMMAND_SYNC_SECRET");
const endpoint = commandSyncUrl(authServerUrl);

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "x-hydra-admin-secret": adminSecret,
  },
});

const body = await response.text();
if (!response.ok) {
  fail(`Discord command sync failed: HTTP ${response.status}\n${body}`);
}

process.stdout.write(`Discord commands synced through ${endpoint.origin}.\n`);
if (body.trim()) {
  process.stdout.write(`${body}\n`);
}

function commandSyncUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    fail("AUTH_SERVER_URL must be a valid URL.");
  }

  const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    fail("AUTH_SERVER_URL must use https unless it points to localhost.");
  }

  parsed.pathname = "/api/discord/commands";
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`${name} is required.`);
  }
  return value;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function printHelp() {
  process.stdout.write(`Sync centralized Hydra Discord slash commands.

Required environment:
  HYDRA_ALLOW_DISCORD_COMMAND_SYNC=1
  AUTH_SERVER_URL=https://...
  DISCORD_COMMAND_SYNC_SECRET=...

Example:
  HYDRA_ALLOW_DISCORD_COMMAND_SYNC=1 \\
  AUTH_SERVER_URL=https://hydra-auth.example.workers.dev \\
  DISCORD_COMMAND_SYNC_SECRET=... \\
  npm run discord:sync:centralized
`);
}
