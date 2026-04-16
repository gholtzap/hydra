#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const env = { ...process.env };
const builderArgs = [...args];

const hasExplicitSigningConfig =
  Boolean(env.CSC_LINK?.trim()) ||
  env.HYDRA_FORCE_MAC_SIGNING === "1";

if (!hasExplicitSigningConfig) {
  delete env.CSC_LINK;
  delete env.CSC_KEY_PASSWORD;
  delete env.APPLE_API_KEY;
  delete env.APPLE_API_KEY_ID;
  delete env.APPLE_API_ISSUER;
  delete env.APPLE_ID;
  delete env.APPLE_APP_SPECIFIC_PASSWORD;
  delete env.APPLE_TEAM_ID;
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  builderArgs.push("-c.mac.hardenedRuntime=false");
}

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["electron-builder", ...builderArgs],
  {
    cwd: process.cwd(),
    env,
    stdio: "inherit"
  }
);

if (result.error) {
  process.stderr.write(`run-electron-builder: failed to spawn electron-builder: ${result.error.message}\n`);
}

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
