import type { SessionSearchResponse, SessionSearchResult, SessionSearchSource } from "../shared-types";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REQUIRED_TOOLS = ["fzf", "rg"];
const INSTALL_COMMAND = "brew install fzf ripgrep";
const MAX_RESULTS = 50;
const MAX_CODEX_METADATA_BYTES = 64 * 1024;

type SearchToolPaths = {
  fzfPath: string | null;
  rgPath: string | null;
  missingTools: string[];
};

type SessionSearchFileRecord = Omit<SessionSearchResult, "lineNumber" | "preview">;

function searchProjectSessions(repoPath: string): SessionSearchResponse {
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

  const tools = resolveRequiredTools();
  if (tools.missingTools.length > 0) {
    return {
      ok: false,
      error: `Install required search tools first: ${INSTALL_COMMAND}`,
      installCommand: INSTALL_COMMAND,
      missingTools: tools.missingTools,
      results: []
    };
  }

  const searchText = trimmedRepoPath;
  const claudeFiles = collectClaudeFiles(trimmedRepoPath);
  const codexFiles = collectCodexFiles(trimmedRepoPath, tools.rgPath);
  const allFiles = [...claudeFiles, ...codexFiles];
  const matches = collectMatches(searchText, allFiles, tools.rgPath);
  const results = rankMatches(matches, searchText, tools.fzfPath);

  return {
    ok: true,
    installCommand: INSTALL_COMMAND,
    missingTools: [],
    results
  };
}

function queryProjectSessions(repoPath: string, query: string): SessionSearchResponse {
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

  const tools = resolveRequiredTools();
  if (tools.missingTools.length > 0) {
    return {
      ok: false,
      error: `Install required search tools first: ${INSTALL_COMMAND}`,
      installCommand: INSTALL_COMMAND,
      missingTools: tools.missingTools,
      results: []
    };
  }

  const claudeFiles = collectClaudeFiles(trimmedRepoPath);
  const codexFiles = collectCodexFiles(trimmedRepoPath, tools.rgPath);
  const allFiles = [...claudeFiles, ...codexFiles];
  const matches = collectMatches(trimmedQuery, allFiles, tools.rgPath);
  const results = rankMatches(matches, trimmedQuery, tools.fzfPath);

  return {
    ok: true,
    installCommand: INSTALL_COMMAND,
    missingTools: [],
    results
  };
}

function resolveRequiredTools(): SearchToolPaths {
  const resolved: Omit<SearchToolPaths, "missingTools"> = {
    fzfPath: null,
    rgPath: null
  };
  const missingTools: string[] = [];

  for (const toolName of REQUIRED_TOOLS) {
    const toolPath = resolveCommandPath(toolName);
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

function collectClaudeFiles(repoPath: string): SessionSearchFileRecord[] {
  const projectDir = path.join(os.homedir(), ".claude", "projects", claudeProjectKey(repoPath));

  let entries = [];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry: import("node:fs").Dirent) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry: import("node:fs").Dirent) => {
      const filePath = path.join(projectDir, entry.name);
      return {
        source: "claude",
        filePath,
        sessionId: path.basename(entry.name, ".jsonl"),
        title: `Claude ${path.basename(entry.name, ".jsonl").slice(0, 8)}`
      };
    });
}

function collectCodexFiles(repoPath: string, rgPath: string | null): SessionSearchFileRecord[] {
  if (!rgPath) {
    return [];
  }

  const codexRoot = path.join(os.homedir(), ".codex", "sessions");
  const discoveredPaths = runListCommand(
    rgPath,
    ["-l", "--glob", "*.jsonl", "--fixed-strings", `"cwd":"${repoPath}"`, codexRoot]
  );

  return discoveredPaths
    .map((filePath: string) => buildCodexFileRecord(filePath, repoPath))
    .filter((record): record is SessionSearchFileRecord => !!record);
}

function buildCodexFileRecord(filePath: string, repoPath: string): SessionSearchFileRecord | null {
  let fileHandle;
  try {
    fileHandle = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(MAX_CODEX_METADATA_BYTES);
    const bytesRead = fs.readSync(fileHandle, buffer, 0, buffer.length, 0);
    const snippet = buffer.toString("utf8", 0, bytesRead);
    const cwdMatch = snippet.match(/"cwd":"([^"]+)"/);
    if (!cwdMatch || cwdMatch[1] !== repoPath) {
      return null;
    }

    const sessionIdMatch = snippet.match(/"id":"([^"]+)"/);
    const timestampMatch = snippet.match(/"timestamp":"([^"]+)"/);
    const displayStamp = timestampMatch ? timestampMatch[1].slice(0, 16).replace("T", " ") : "";

    return {
      source: "codex",
      filePath,
      sessionId: sessionIdMatch ? sessionIdMatch[1] : null,
      title: displayStamp ? `Codex ${displayStamp}` : `Codex ${path.basename(filePath, ".jsonl")}`
    };
  } catch {
    return null;
  } finally {
    if (fileHandle !== undefined) {
      fs.closeSync(fileHandle);
    }
  }
}

function collectMatches(
  query: string,
  files: SessionSearchFileRecord[],
  rgPath: string | null
): SessionSearchResult[] {
  if (!rgPath) {
    return [];
  }

  if (!files.length) {
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
  const lines = runListCommand(rgPath, args);
  const fileByPath = new Map<string, SessionSearchFileRecord>(files.map((file) => [file.filePath, file]));

  return lines
    .map((line) => parseRgLine(line, fileByPath))
    .filter((match): match is SessionSearchResult => !!match);
}

function parseRgLine(line: string, fileByPath: Map<string, SessionSearchFileRecord>): SessionSearchResult | null {
  const firstColon = line.indexOf(":");
  if (firstColon === -1) {
    return null;
  }

  const secondColon = line.indexOf(":", firstColon + 1);
  if (secondColon === -1) {
    return null;
  }

  const filePath = line.slice(0, firstColon);
  const lineText = line.slice(secondColon + 1).trim();
  const lineNumber = Number(line.slice(firstColon + 1, secondColon));
  const file = fileByPath.get(filePath);

  if (!file || !Number.isFinite(lineNumber)) {
    return null;
  }

  return {
    ...file,
    lineNumber,
    preview: lineText
  };
}

function rankMatches(matches: SessionSearchResult[], query: string, fzfPath: string | null): SessionSearchResult[] {
  if (!fzfPath) {
    return matches.slice(0, MAX_RESULTS);
  }

  if (!matches.length) {
    return [];
  }

  const candidates = matches.map((match, index) =>
    `${index}\t${match.source}\t${match.title}\t${match.lineNumber}\t${match.preview}`
  );
  const rankedLines = runListCommand(fzfPath, [
    "--filter",
    query,
    "--delimiter",
    "\t",
    "--with-nth",
    "2..",
    "--no-sort"
  ], candidates.join("\n"));

  const ordered: SessionSearchResult[] = [];
  for (const line of rankedLines.slice(0, MAX_RESULTS)) {
    const tabIndex = line.indexOf("\t");
    if (tabIndex === -1) {
      continue;
    }

    const matchIndex = Number(line.slice(0, tabIndex));
    if (!Number.isFinite(matchIndex) || !matches[matchIndex]) {
      continue;
    }

    ordered.push(matches[matchIndex] as SessionSearchResult);
  }

  return ordered;
}

function runListCommand(commandPath: string, args: string[], stdinText = ""): string[] {
  const result = spawnSync(commandPath, args, {
    encoding: "utf8",
    input: stdinText,
    maxBuffer: 8 * 1024 * 1024
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && result.status !== 1) {
    const message = (result.stderr || result.stdout || "").trim();
    throw new Error(message || `Command failed: ${path.basename(commandPath)}`);
  }

  const output = (result.stdout || "").trim();
  return output ? output.split("\n").filter(Boolean) : [];
}

function claudeProjectKey(repoPath: string): string {
  return path.resolve(repoPath).replace(/[^a-zA-Z0-9]/g, "-");
}

function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  const normalizedFilePath = path.resolve(filePath);
  const normalizedRootPath = path.resolve(rootPath);
  const relativePath = path.relative(normalizedRootPath, normalizedFilePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function codexSessionBelongsToRepo(filePath: string, repoPath: string): boolean {
  let fileHandle;
  try {
    fileHandle = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(MAX_CODEX_METADATA_BYTES);
    const bytesRead = fs.readSync(fileHandle, buffer, 0, buffer.length, 0);
    const snippet = buffer.toString("utf8", 0, bytesRead);
    const cwdMatch = snippet.match(/"cwd":"([^"]+)"/);
    return !!cwdMatch && path.resolve(cwdMatch[1]) === path.resolve(repoPath);
  } catch {
    return false;
  } finally {
    if (fileHandle !== undefined) {
      fs.closeSync(fileHandle);
    }
  }
}

function isSessionSearchResultPathForRepo(filePath: string, repoPath: string): boolean {
  const normalizedFilePath = typeof filePath === "string" && filePath.trim()
    ? path.resolve(filePath)
    : "";
  const normalizedRepoPath = typeof repoPath === "string" && repoPath.trim()
    ? path.resolve(repoPath)
    : "";
  if (!normalizedFilePath || !normalizedRepoPath || path.extname(normalizedFilePath).toLowerCase() !== ".jsonl") {
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

function resolveCommandPath(command: string): string | null {
  const searchPaths = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    path.join(process.env.HOME || "", ".local/bin")
  ];

  for (const dir of searchPaths) {
    const fullPath = path.join(dir, command);
    try {
      fs.accessSync(fullPath, fs.constants.X_OK);
      return fullPath;
    } catch {
      continue;
    }
  }

  return null;
}

module.exports = {
  INSTALL_COMMAND,
  isSessionSearchResultPathForRepo,
  queryProjectSessions,
  searchProjectSessions
};
