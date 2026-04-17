#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const DEFAULT_APP_PATH = path.join("release", "mac-arm64", "Hydra.app");
const DEFAULT_EXPECTED_OUTPUT = "HYDRA_SMOKE_OK";
const DEFAULT_TIMEOUT_MS = 20_000;

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("This smoke runner only supports macOS packaged apps.");
  }

  const appPath = path.resolve(process.argv[2] || DEFAULT_APP_PATH);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hydra-packaged-smoke-"));
  const tmpDir = path.join(tempRoot, "tmp");
  const homeDir = path.join(tempRoot, "home");
  const userDataDir = path.join(tempRoot, "user-data");
  const workspacePath = path.join(tempRoot, "workspace");
  const resultPath = path.join(tempRoot, "result.json");
  const keepTemp = process.env.HYDRA_SMOKE_KEEP_TEMP === "1";
  const fakeCommandName = "hydra-smoke-codex";
  const fakeCodexPath = path.join(homeDir, ".local", "bin", fakeCommandName);

  await Promise.all([
    mkdir(tmpDir, { recursive: true }),
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspacePath, { recursive: true }),
    writeFakeCodex(fakeCodexPath, DEFAULT_EXPECTED_OUTPUT)
  ]);
  await writeFile(path.join(workspacePath, "package.json"), '{ "name": "hydra-smoke" }\n', "utf8");

  await verifyCommandResolution(homeDir, fakeCommandName, fakeCodexPath);

  console.log(`[smoke] Launching packaged app: ${appPath}`);
  console.log(`[smoke] Workspace: ${workspacePath}`);
  console.log(`[smoke] User data: ${userDataDir}`);
  console.log(`[smoke] Fake codex: ${fakeCodexPath}`);

  let stdout = "";
  let stderr = "";

  try {
    const openArgs = [
      "-W",
      "-n",
      "-a",
      appPath
    ];
    const exit = await launchOpenCommand(openArgs, {
      env: {
        ...process.env,
        HYDRA_SMOKE_TEST: "1",
        HYDRA_SMOKE_AGENT_ID: "codex",
        HYDRA_SMOKE_AGENT_COMMAND: fakeCodexPath,
        HYDRA_SMOKE_EXPECTED_OUTPUT: DEFAULT_EXPECTED_OUTPUT,
        HYDRA_SMOKE_RESULT_PATH: resultPath,
        HYDRA_SMOKE_TIMEOUT_MS: String(DEFAULT_TIMEOUT_MS),
        HYDRA_SMOKE_USER_DATA_DIR: userDataDir,
        HYDRA_SMOKE_WORKSPACE_PATH: workspacePath,
        PATH: "/usr/bin:/bin",
        TMPDIR: tmpDir
      },
      onStdout: (chunk) => {
        stdout += chunk;
      },
      onStderr: (chunk) => {
        stderr += chunk;
      },
      timeoutMs: DEFAULT_TIMEOUT_MS + 15_000
    });
    const result = await readSmokeResult(resultPath);

    if (exit.timedOut) {
      throw new Error(`Smoke launch timed out after ${exit.timeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }

    if (exit.code !== 0) {
      throw new Error(
        `open exited with code ${String(exit.code)} signal ${String(exit.signal)}.\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
    }

    if (!result?.ok) {
      const details = JSON.stringify(result, null, 2);
      throw new Error(
        `Packaged smoke test failed.\nresult:\n${details}\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
    }

    console.log(`[smoke] PASS ${result.stage}: ${result.message}`);
    if (result.transcriptPreview) {
      console.log(`[smoke] transcript: ${result.transcriptPreview}`);
    }
  } finally {
    if (keepTemp) {
      console.log(`[smoke] Keeping temp directory: ${tempRoot}`);
    } else {
      await rm(tempRoot, { force: true, recursive: true });
    }
  }
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

async function writeFakeCodex(fakeCodexPath, marker) {
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' ${shellSingleQuote(marker)}`
  ].join("\n");

  await mkdir(path.dirname(fakeCodexPath), { recursive: true });
  await writeFile(fakeCodexPath, `${script}\n`, "utf8");
  await chmod(fakeCodexPath, 0o755);
}

async function verifyCommandResolution(homeDir, fakeCommandName, fakeCodexPath) {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  try {
    const commandPathModulePath = path.resolve("dist-electron/main/command-path.js");
    const { resolveCommandPathSync } = require(commandPathModulePath);
    const resolvedPath = resolveCommandPathSync(fakeCommandName, "/usr/bin:/bin");
    if (resolvedPath !== fakeCodexPath) {
      throw new Error(
        `Expected resolveCommandPathSync('${fakeCommandName}') to return ${fakeCodexPath}, got ${String(resolvedPath)}`
      );
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
}

async function launchOpenCommand(args, options) {
  const command = `open ${args.map((value) => shellSingleQuote(value)).join(" ")}`;
  const child = spawn("/bin/zsh", ["-lc", command], {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    options.onStdout(chunk);
  });
  child.stderr.on("data", (chunk) => {
    options.onStderr(chunk);
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGKILL");
      resolve({
        code: null,
        signal: "SIGKILL",
        timedOut: true,
        timeoutMs: options.timeoutMs
      });
    }, options.timeoutMs);

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({
        code,
        signal,
        timedOut: false,
        timeoutMs: options.timeoutMs
      });
    });
  });
}

async function readSmokeResult(resultPath) {
  try {
    return JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    return null;
  }
}

await main().catch((error) => {
  console.error(`[smoke] FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
