import type { SessionSearchResponse, SessionSearchResult } from "../shared-types";

const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process") as typeof import("node:child_process");
const { resolveCommandPath } = require("./command-path") as {
  resolveCommandPath: (command: string) => Promise<string | null>;
};
const { isPathWithinRoot } = require("./shared-utils") as {
  isPathWithinRoot: (filePath: string, rootPath: string) => boolean;
};

const REQUIRED_TOOLS = ["fzf", "rg"];
const INSTALL_COMMAND = process.platform === "win32"
  ? "scoop install fzf ripgrep"
  : "brew install fzf ripgrep";
const MAX_RESULTS = 50;
const MAX_CODEX_METADATA_BYTES = 64 * 1024;
const COMMAND_OUTPUT_MAX_BUFFER = 8 * 1024 * 1024;
const SESSION_FILE_CACHE_TTL_MS = 5_000;
const SESSION_FILE_CACHE_MAX_ENTRIES = 12;

type SearchToolPaths = {
  fzfPath: string | null;
  rgPath: string | null;
  missingTools: string[];
};

type RipgrepMatchLine = {
  filePath: string;
  lineNumber: number;
  lineText: string;
};

type SessionSearchFileRecord = Omit<SessionSearchResult, "lineNumber" | "preview">;
type SessionSearchFileCacheEntry = {
  cachedAt: number;
  files: SessionSearchFileRecord[];
  pending: Promise<SessionSearchFileRecord[]> | null;
};

const sessionSearchFileCache = new Map<string, SessionSearchFileCacheEntry>();
const CODEX_SESSION_META_PREFIX =
  /^\{"timestamp":"([^"]+)","type":"session_meta","payload":\{"id":"([^"]+)","timestamp":"[^"]+","cwd":/;

async function searchProjectSessions(repoPath: string): Promise<SessionSearchResponse> {
  const trimmedRepoPath = typeof repoPath === "string" ? repoPath.trim() : "";
  if (!trimmedRepoPath) {
    return {
      ok: false,
      error: "Select a project before searching session files.",
      installCommand: INSTALL_COMMAND,
      missingTools: [],
      results: []
    };
  }

  const tools = await resolveRequiredTools();
  if (tools.missingTools.length > 0) {
    return {
      ok: false,
      error: `Install required search tools first: ${INSTALL_COMMAND}`,
      installCommand: INSTALL_COMMAND,
      missingTools: tools.missingTools,
      results: []
    };
  }

  const normalizedRepoPath = normalizeRepoSearchPath(trimmedRepoPath);
  const allFiles = await getSessionSearchFileRecords(normalizedRepoPath, tools.rgPath);
  const matches = await collectMatches(normalizedRepoPath, allFiles, tools.rgPath);
  const results = await rankMatches(matches, normalizedRepoPath, tools.fzfPath);

  return {
    ok: true,
    installCommand: INSTALL_COMMAND,
    missingTools: [],
    results
  };
}

async function queryProjectSessions(repoPath: string, query: string): Promise<SessionSearchResponse> {
  const trimmedQuery = typeof query === "string" ? query.trim() : "";
  if (!trimmedQuery) {
    return {
      ok: true,
      installCommand: INSTALL_COMMAND,
      missingTools: [],
      results: []
    };
  }

  const trimmedRepoPath = typeof repoPath === "string" ? repoPath.trim() : "";
  if (!trimmedRepoPath) {
    return {
      ok: false,
      error: "Select a project before searching session files.",
      installCommand: INSTALL_COMMAND,
      missingTools: [],
      results: []
    };
  }

  const tools = await resolveRequiredTools();
  if (tools.missingTools.length > 0) {
    return {
      ok: false,
      error: `Install required search tools first: ${INSTALL_COMMAND}`,
      installCommand: INSTALL_COMMAND,
      missingTools: tools.missingTools,
      results: []
    };
  }

  const normalizedRepoPath = normalizeRepoSearchPath(trimmedRepoPath);
  const allFiles = await getSessionSearchFileRecords(normalizedRepoPath, tools.rgPath);
  const matches = await collectMatches(trimmedQuery, allFiles, tools.rgPath);
  const results = await rankMatches(matches, trimmedQuery, tools.fzfPath);

  return {
    ok: true,
    installCommand: INSTALL_COMMAND,
    missingTools: [],
    results
  };
}

function normalizeRepoSearchPath(repoPath: string): string {
  return path.resolve(repoPath);
}

function touchSessionSearchFileCache(
  repoPath: string,
  entry: SessionSearchFileCacheEntry
): void {
  sessionSearchFileCache.delete(repoPath);
  sessionSearchFileCache.set(repoPath, entry);
}

function pruneSessionSearchFileCache(nowMs: number = Date.now()): void {
  for (const [repoPath, entry] of sessionSearchFileCache) {
    if (!entry.pending && nowMs - entry.cachedAt > SESSION_FILE_CACHE_TTL_MS) {
      sessionSearchFileCache.delete(repoPath);
    }
  }

  while (sessionSearchFileCache.size > SESSION_FILE_CACHE_MAX_ENTRIES) {
    const oldestSettledEntry = Array.from(sessionSearchFileCache.entries()).find(
      ([, entry]) => !entry.pending
    );
    if (!oldestSettledEntry) {
      break;
    }

    sessionSearchFileCache.delete(oldestSettledEntry[0]);
  }
}

function invalidateSessionSearchCache(repoPath?: string | null): void {
  if (!repoPath || !repoPath.trim()) {
    sessionSearchFileCache.clear();
    return;
  }

  sessionSearchFileCache.delete(normalizeRepoSearchPath(repoPath.trim()));
}

async function getSessionSearchFileRecords(
  repoPath: string,
  rgPath: string | null
): Promise<SessionSearchFileRecord[]> {
  const normalizedRepoPath = normalizeRepoSearchPath(repoPath);
  const nowMs = Date.now();
  pruneSessionSearchFileCache(nowMs);

  const existingEntry = sessionSearchFileCache.get(normalizedRepoPath);
  if (existingEntry?.pending) {
    return existingEntry.pending;
  }

  if (existingEntry && nowMs - existingEntry.cachedAt <= SESSION_FILE_CACHE_TTL_MS) {
    touchSessionSearchFileCache(normalizedRepoPath, existingEntry);
    return existingEntry.files;
  }

  const pending = loadSessionSearchFileRecords(normalizedRepoPath, rgPath);
  touchSessionSearchFileCache(normalizedRepoPath, {
    cachedAt: existingEntry?.cachedAt ?? 0,
    files: existingEntry?.files ?? [],
    pending
  });

  try {
    const files = await pending;
    touchSessionSearchFileCache(normalizedRepoPath, {
      cachedAt: Date.now(),
      files,
      pending: null
    });
    pruneSessionSearchFileCache();
    return files;
  } catch (error) {
    const currentEntry = sessionSearchFileCache.get(normalizedRepoPath);
    if (currentEntry?.pending === pending) {
      if (existingEntry) {
        touchSessionSearchFileCache(normalizedRepoPath, {
          cachedAt: existingEntry.cachedAt,
          files: existingEntry.files,
          pending: null
        });
      } else {
        sessionSearchFileCache.delete(normalizedRepoPath);
      }
    }

    throw error;
  }
}

async function loadSessionSearchFileRecords(
  repoPath: string,
  rgPath: string | null
): Promise<SessionSearchFileRecord[]> {
  const claudeFiles = await collectClaudeFiles(repoPath);
  const codexFiles = await collectCodexFiles(repoPath, rgPath);
  return [...claudeFiles, ...codexFiles];
}

async function resolveRequiredTools(): Promise<SearchToolPaths> {
  const resolved: Omit<SearchToolPaths, "missingTools"> = {
    fzfPath: null,
    rgPath: null
  };
  const missingTools: string[] = [];

  for (const toolName of REQUIRED_TOOLS) {
    const toolPath = await resolveCommandPath(toolName);
    if (!toolPath) {
      missingTools.push(toolName);
      continue;
    }

    if (toolName === "fzf") {
      resolved.fzfPath = toolPath;
    } else if (toolName === "rg") {
      resolved.rgPath = toolPath;
    }
  }

  return {
    ...resolved,
    missingTools
  };
}

async function collectClaudeFiles(repoPath: string): Promise<SessionSearchFileRecord[]> {
  const projectDir = path.join(os.homedir(), ".claude", "projects", claudeProjectKey(repoPath));

  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fsp.readdir(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const filePath = path.join(projectDir, entry.name);
      const sessionId = path.basename(entry.name, ".jsonl");
      return {
        source: "claude",
        filePath,
        sessionId,
        title: `Claude ${sessionId.slice(0, 8)}`
      };
    });
}

async function collectCodexFiles(
  repoPath: string,
  rgPath: string | null
): Promise<SessionSearchFileRecord[]> {
  if (!rgPath) {
    return [];
  }

  const codexRoot = path.join(os.homedir(), ".codex", "sessions");
  const metadataPrefixLines = await runListCommand(
    rgPath,
    [
      "--color=never",
      "--with-filename",
      "--line-number",
      "--max-count",
      "1",
      "--only-matching",
      "--glob",
      "*.jsonl",
      codexSessionMetadataPrefixPattern(repoPath),
      codexRoot
    ]
  );

  return metadataPrefixLines
    .map((line) => buildCodexFileRecord(line))
    .filter((record): record is SessionSearchFileRecord => !!record);
}

function codexSessionMetadataPrefixPattern(repoPath: string): string {
  const serializedRepoPath = JSON.stringify(repoPath);
  const escapedRepoPath = escapeRipgrepPattern(serializedRepoPath);
  return `\\{"timestamp":"[^"]+","type":"session_meta","payload":\\{"id":"[^"]+","timestamp":"[^"]+","cwd":${escapedRepoPath}`;
}

function escapeRipgrepPattern(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function buildCodexFileRecord(line: string): SessionSearchFileRecord | null {
  const matchLine = parseRipgrepMatchLine(line);
  if (!matchLine) {
    return null;
  }

  const metadataMatch = matchLine.lineText.match(CODEX_SESSION_META_PREFIX);
  if (!metadataMatch) {
    return null;
  }

  const [, timestamp, sessionId] = metadataMatch;
  const displayStamp = timestamp ? timestamp.slice(0, 16).replace("T", " ") : "";

  return {
    source: "codex",
    filePath: matchLine.filePath,
    sessionId: sessionId || null,
    title: displayStamp
      ? `Codex ${displayStamp}`
      : `Codex ${path.basename(matchLine.filePath, ".jsonl")}`
  };
}

async function collectMatches(
  query: string,
  files: SessionSearchFileRecord[],
  rgPath: string | null
): Promise<SessionSearchResult[]> {
  if (!rgPath || !files.length) {
    return [];
  }

  const args = [
    "--color=never",
    "--with-filename",
    "--line-number",
    "--max-columns=400",
    "--smart-case",
    "--fixed-strings",
    query,
    ...files.map((file) => file.filePath)
  ];
  const lines = await runListCommand(rgPath, args);
  const fileByPath = new Map<string, SessionSearchFileRecord>(
    files.map((file) => [file.filePath, file])
  );

  return lines
    .map((line) => parseRgLine(line, fileByPath))
    .filter((match): match is SessionSearchResult => !!match);
}

function parseRgLine(
  line: string,
  fileByPath: Map<string, SessionSearchFileRecord>
): SessionSearchResult | null {
  const matchLine = parseRipgrepMatchLine(line);
  if (!matchLine) {
    return null;
  }

  const file = fileByPath.get(matchLine.filePath);

  if (!file) {
    return null;
  }

  return {
    ...file,
    lineNumber: matchLine.lineNumber,
    preview: matchLine.lineText
  };
}

function parseRipgrepMatchLine(line: string): RipgrepMatchLine | null {
  const lineStart = line.length >= 3 && /^[A-Za-z]:[\\/]/.test(line) ? 2 : 0;
  const firstColon = line.indexOf(":", lineStart);
  if (firstColon === -1) {
    return null;
  }

  const secondColon = line.indexOf(":", firstColon + 1);
  if (secondColon === -1) {
    return null;
  }

  const filePath = line.slice(0, firstColon);
  const lineNumber = Number(line.slice(firstColon + 1, secondColon));
  if (!filePath || !Number.isFinite(lineNumber)) {
    return null;
  }

  return {
    filePath,
    lineNumber,
    lineText: line.slice(secondColon + 1).trim()
  };
}

async function rankMatches(
  matches: SessionSearchResult[],
  query: string,
  fzfPath: string | null
): Promise<SessionSearchResult[]> {
  if (!fzfPath) {
    return matches.slice(0, MAX_RESULTS);
  }

  if (!matches.length) {
    return [];
  }

  const candidates = matches.map(
    (match, index) =>
      `${index}\t${match.source}\t${match.title}\t${match.lineNumber}\t${match.preview}`
  );
  const rankedLines = await runListCommand(
    fzfPath,
    [
      "--filter",
      query,
      "--delimiter",
      "\t",
      "--with-nth",
      "2..",
      "--no-sort"
    ],
    candidates.join("\n")
  );

  return indexedMatchesFromRankedLines(matches, rankedLines, MAX_RESULTS);
}

function indexedMatchesFromRankedLines<T>(
  matches: T[],
  rankedLines: string[],
  limit: number
): T[] {
  const ordered: T[] = [];

  for (const line of rankedLines.slice(0, limit)) {
    const match = indexedValueFromRankedLine(matches, line);
    if (match !== null) {
      ordered.push(match);
    }
  }

  return ordered;
}

function indexedValueFromRankedLine<T>(matches: T[], line: string): T | null {
  const tabIndex = line.indexOf("\t");
  if (tabIndex === -1) {
    return null;
  }

  const matchIndex = Number(line.slice(0, tabIndex));
  if (!Number.isFinite(matchIndex)) {
    return null;
  }

  return matches[matchIndex] ?? null;
}

async function runListCommand(
  commandPath: string,
  args: string[],
  stdinText = ""
): Promise<string[]> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(commandPath, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finishReject = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    const appendChunk = (
      current: string,
      chunk: string,
      streamLabel: "stdout" | "stderr"
    ): string => {
      const nextSize = Buffer.byteLength(current) + Buffer.byteLength(chunk);
      if (nextSize > COMMAND_OUTPUT_MAX_BUFFER) {
        child.kill();
        finishReject(new Error(`${path.basename(commandPath)} ${streamLabel} exceeded buffer limit.`));
        return current;
      }

      return `${current}${chunk}`;
    };

    child.on("error", (error) => finishReject(error));

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendChunk(stdout, chunk, "stdout");
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendChunk(stderr, chunk, "stderr");
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      if (code !== 0 && code !== 1) {
        const message = (stderr || stdout || "").trim();
        reject(new Error(message || `Command failed: ${path.basename(commandPath)}`));
        return;
      }

      resolve(stdout);
    });

    child.stdin?.end(stdinText, "utf8");
  });

  const trimmedOutput = output.trim();
  return trimmedOutput ? trimmedOutput.split("\n").filter(Boolean) : [];
}

function claudeProjectKey(repoPath: string): string {
  return path.resolve(repoPath).replace(/[^a-zA-Z0-9]/g, "-");
}

async function codexSessionBelongsToRepo(filePath: string, repoPath: string): Promise<boolean> {
  const snippet = await readCodexMetadataSnippet(filePath);
  if (!snippet) {
    return false;
  }

  const cwdMatch = snippet.match(/"cwd":"([^"]+)"/);
  return !!cwdMatch && path.resolve(cwdMatch[1]) === path.resolve(repoPath);
}

async function isSessionSearchResultPathForRepo(
  filePath: string,
  repoPath: string
): Promise<boolean> {
  const normalizedFilePath =
    typeof filePath === "string" && filePath.trim() ? path.resolve(filePath) : "";
  const normalizedRepoPath =
    typeof repoPath === "string" && repoPath.trim() ? path.resolve(repoPath) : "";
  if (
    !normalizedFilePath ||
    !normalizedRepoPath ||
    path.extname(normalizedFilePath).toLowerCase() !== ".jsonl"
  ) {
    return false;
  }

  const claudeProjectDir = path.join(
    os.homedir(),
    ".claude",
    "projects",
    claudeProjectKey(normalizedRepoPath)
  );
  if (isPathWithinRoot(normalizedFilePath, claudeProjectDir)) {
    return true;
  }

  const codexSessionsRoot = path.join(os.homedir(), ".codex", "sessions");
  if (!isPathWithinRoot(normalizedFilePath, codexSessionsRoot)) {
    return false;
  }

  return codexSessionBelongsToRepo(normalizedFilePath, normalizedRepoPath);
}

async function readCodexMetadataSnippet(filePath: string): Promise<string> {
  let fileHandle: import("node:fs/promises").FileHandle | null = null;

  try {
    fileHandle = await fsp.open(filePath, "r");
    const buffer = Buffer.alloc(MAX_CODEX_METADATA_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

module.exports = {
  INSTALL_COMMAND,
  invalidateSessionSearchCache,
  isSessionSearchResultPathForRepo,
  queryProjectSessions,
  searchProjectSessions
};
