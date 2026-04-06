const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REQUIRED_TOOLS = ["fzf", "rg"];
const INSTALL_COMMAND = "brew install fzf ripgrep";
const MAX_RESULTS = 50;
const MAX_CODEX_METADATA_BYTES = 64 * 1024;

function searchProjectSessions(repoPath) {
  const trimmedRepoPath = typeof repoPath === "string" ? repoPath.trim() : "";
  if (!trimmedRepoPath) {
    return {
      ok: false,
      error: "Select a project before searching session files.",
      installCommand: INSTALL_COMMAND,
      missingTools: []
    };
  }

  const tools = resolveRequiredTools();
  if (tools.missingTools.length > 0) {
    return {
      ok: false,
      error: `Install required search tools first: ${INSTALL_COMMAND}`,
      installCommand: INSTALL_COMMAND,
      missingTools: tools.missingTools
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

function queryProjectSessions(repoPath, query) {
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
      missingTools: []
    };
  }

  const tools = resolveRequiredTools();
  if (tools.missingTools.length > 0) {
    return {
      ok: false,
      error: `Install required search tools first: ${INSTALL_COMMAND}`,
      installCommand: INSTALL_COMMAND,
      missingTools: tools.missingTools
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

function resolveRequiredTools() {
  const resolved = {
    fzfPath: null,
    rgPath: null
  };
  const missingTools = [];

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

function collectClaudeFiles(repoPath) {
  const projectDir = path.join(os.homedir(), ".claude", "projects", claudeProjectKey(repoPath));

  let entries = [];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const filePath = path.join(projectDir, entry.name);
      return {
        source: "claude",
        filePath,
        sessionId: path.basename(entry.name, ".jsonl"),
        title: `Claude ${path.basename(entry.name, ".jsonl").slice(0, 8)}`
      };
    });
}

function collectCodexFiles(repoPath, rgPath) {
  const codexRoot = path.join(os.homedir(), ".codex", "sessions");
  const discoveredPaths = runListCommand(
    rgPath,
    ["-l", "--glob", "*.jsonl", "--fixed-strings", `"cwd":"${repoPath}"`, codexRoot]
  );

  return discoveredPaths
    .map((filePath) => buildCodexFileRecord(filePath, repoPath))
    .filter(Boolean);
}

function buildCodexFileRecord(filePath, repoPath) {
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

function collectMatches(query, files, rgPath) {
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
  const fileByPath = new Map(files.map((file) => [file.filePath, file]));

  return lines
    .map((line) => parseRgLine(line, fileByPath))
    .filter(Boolean);
}

function parseRgLine(line, fileByPath) {
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

function rankMatches(matches, query, fzfPath) {
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

  const ordered = [];
  for (const line of rankedLines.slice(0, MAX_RESULTS)) {
    const tabIndex = line.indexOf("\t");
    if (tabIndex === -1) {
      continue;
    }

    const matchIndex = Number(line.slice(0, tabIndex));
    if (!Number.isFinite(matchIndex) || !matches[matchIndex]) {
      continue;
    }

    ordered.push(matches[matchIndex]);
  }

  return ordered;
}

function runListCommand(commandPath, args, stdinText = "") {
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

function claudeProjectKey(repoPath) {
  return path.resolve(repoPath).replace(/[^a-zA-Z0-9]/g, "-");
}

function resolveCommandPath(command) {
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
  queryProjectSessions,
  searchProjectSessions
};
