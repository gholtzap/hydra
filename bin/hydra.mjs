#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_MCP_URL = "http://127.0.0.1:4141/mcp";
const MCP_AUTH_TOKEN_ENV = "HYDRA_MCP_AUTH_TOKEN";
const MCP_AUTH_TOKEN_FILE_ENV = "HYDRA_MCP_AUTH_TOKEN_FILE";
const MCP_TOKEN_FILE_NAME = "mcp-auth-token";
const MAX_SESSION_PROMPT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (!command || options.help) {
    printHelp(command);
    return;
  }

  switch (command) {
    case "create-session":
    case "launch-agent":
      await createSession(options);
      return;
    default:
      throw new CliError(`Unknown command: ${command}`);
  }
}

async function createSession(options) {
  const repoId = requiredOption(options.repoId, "--repo-id");
  const prompt = await resolvePrompt(options);

  if (!prompt.trim()) {
    throw new CliError("--prompt is required and cannot be empty.");
  }
  if (prompt.length > MAX_SESSION_PROMPT_CHARS) {
    throw new CliError(`--prompt must be ${MAX_SESSION_PROMPT_CHARS} characters or fewer.`);
  }

  const toolResult = await callCreateSessionTool({
    authToken: await resolveAuthToken(options),
    mcpUrl: options.mcpUrl || DEFAULT_MCP_URL,
    timeoutMs: parseTimeoutMs(options.timeoutMs),
    arguments: {
      repoId,
      prompt,
      ...(options.agentId ? { agentId: options.agentId.trim() } : {}),
    },
  });
  const sessionId = extractCreatedSessionId(toolResult);

  process.stdout.write(`${JSON.stringify({
    ok: !!sessionId,
    sessionId,
    repoId,
    agentId: options.agentId?.trim() || null,
    tool: "create_session",
    ...(options.raw ? { mcpResult: toolResult } : {}),
  }, null, 2)}\n`);

  if (!sessionId) {
    process.exitCode = 1;
  }
}

async function callCreateSessionTool({ authToken, mcpUrl, timeoutMs, arguments: toolArguments }) {
  const client = new Client({ name: "hydra-cli", version: await packageVersion() }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${authToken}` },
    },
  });

  try {
    await client.connect(transport);
    return await client.callTool(
      { name: "create_session", arguments: toolArguments },
      undefined,
      { timeout: timeoutMs }
    );
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

function parseArgs(argv) {
  let command = null;
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (!command && !arg.startsWith("-")) {
      command = arg;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--raw") {
      options.raw = true;
      continue;
    }
    if (arg === "--prompt-stdin") {
      options.promptStdin = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new CliError(`Unknown argument: ${arg}`);
    }

    const [rawName, inlineValue] = splitOption(arg);
    const name = normalizeOptionName(rawName);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) {
      throw new CliError(`Missing value for ${rawName}.`);
    }

    switch (name) {
      case "repoId":
      case "agentId":
      case "prompt":
      case "promptFile":
      case "mcpUrl":
      case "authToken":
      case "authTokenFile":
      case "timeoutMs":
        options[name] = value;
        break;
      default:
        throw new CliError(`Unknown argument: ${rawName}`);
    }
  }

  return { command, options };
}

function splitOption(arg) {
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1 ? [arg, undefined] : [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)];
}

function normalizeOptionName(name) {
  return name.replace(/^--/, "").replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
}

function requiredOption(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new CliError(`${label} is required.`);
  }

  return normalized;
}

async function resolvePrompt(options) {
  const sourceCount = [hasOwn(options, "prompt"), hasOwn(options, "promptFile"), !!options.promptStdin]
    .filter(Boolean).length;
  if (sourceCount !== 1) {
    throw new CliError("Provide exactly one of --prompt, --prompt-file, or --prompt-stdin.");
  }
  if (hasOwn(options, "prompt")) {
    return options.prompt;
  }
  if (hasOwn(options, "promptFile")) {
    return readFile(options.promptFile, "utf8");
  }

  return readStdin();
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function parseTimeoutMs(value) {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError("--timeout-ms must be a positive number.");
  }

  return Math.trunc(parsed);
}

async function resolveAuthToken(options) {
  const explicitToken = (options.authToken || process.env[MCP_AUTH_TOKEN_ENV] || "").trim();
  if (explicitToken) {
    return explicitToken;
  }

  const tokenFile = options.authTokenFile || process.env[MCP_AUTH_TOKEN_FILE_ENV] || defaultTokenPath();
  try {
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (token) {
      return token;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  throw new CliError(
    `Could not find an MCP auth token. Start Hydra with MCP enabled, set ${MCP_AUTH_TOKEN_ENV}, or pass --auth-token.`
  );
}

function defaultTokenPath() {
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Hydra", MCP_TOKEN_FILE_NAME);
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"), "Hydra", MCP_TOKEN_FILE_NAME);
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "Hydra", MCP_TOKEN_FILE_NAME);
}

function extractCreatedSessionId(toolResult) {
  if (toolResult?.isError) {
    throw new CliError(firstTextContent(toolResult) || "MCP tool returned an error.");
  }

  const text = firstTextContent(toolResult);
  if (!text) {
    return typeof toolResult === "string" ? toolResult : toolResult?.sessionId || null;
  }

  const parsed = parseToolText(text);
  return typeof parsed === "string" ? parsed : parsed?.sessionId || null;
}

function firstTextContent(toolResult) {
  const content = Array.isArray(toolResult?.content) ? toolResult.content : [];
  return content.find((item) => item?.type === "text" && typeof item.text === "string")?.text || "";
}

function parseToolText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function packageVersion() {
  try {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp(command) {
  const usage = command && command !== "create-session" && command !== "launch-agent"
    ? "hydra <command> [options]"
    : "hydra create-session --repo-id <repoId> --prompt <prompt>";

  process.stdout.write(`${usage}\n\n`);
  process.stdout.write("Commands:\n");
  process.stdout.write("  create-session    Call the MCP create_session tool\n");
  process.stdout.write("  launch-agent      Alias for create-session\n\n");
  process.stdout.write("Options:\n");
  process.stdout.write("  --repo-id <id>            Repo ID to create the session in\n");
  process.stdout.write("  --prompt <text>           Initial prompt for the default agent\n");
  process.stdout.write("  --prompt-file <path>      Read the initial prompt from a file\n");
  process.stdout.write("  --prompt-stdin            Read the initial prompt from stdin\n");
  process.stdout.write("  --agent-id <id>           Optional agent override; omit for the default agent\n");
  process.stdout.write("  --mcp-url <url>           MCP endpoint (default: http://127.0.0.1:4141/mcp)\n");
  process.stdout.write("  --auth-token <token>      MCP bearer token (defaults to HYDRA_MCP_AUTH_TOKEN or token file)\n");
  process.stdout.write("  --auth-token-file <path>  MCP bearer token file\n");
  process.stdout.write("  --timeout-ms <ms>         Request timeout (default: 30000)\n");
  process.stdout.write("  --raw                     Include the raw MCP tool response\n");
}

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliError";
  }
}

main().catch((error) => {
  const message = error instanceof CliError ? error.message : error?.stack || String(error);
  process.stderr.write(`hydra: ${message}\n`);
  process.exitCode = 1;
});
