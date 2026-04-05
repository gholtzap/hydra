const fs = require("node:fs");
const path = require("node:path");

const WIKI_DIRECTORY_NAME = ".wiki";
const WIKI_STAGING_DIRECTORY = "staging";
const WIKI_INSTRUCTION_BLOCK_START = "<!-- claude-workspace:wiki:start -->";
const WIKI_INSTRUCTION_BLOCK_END = "<!-- claude-workspace:wiki:end -->";
const PROJECT_INSTRUCTION_FILE_LAYOUTS = ["AGENTS.md", "CLAUDE.md"];

function wikiDirectoryPath(rootPath) {
  return path.join(rootPath, WIKI_DIRECTORY_NAME);
}

function wikiExists(rootPath) {
  try {
    return fs.statSync(wikiDirectoryPath(rootPath)).isDirectory();
  } catch {
    return false;
  }
}

function detectWikiEnabled(rootPath) {
  for (const filePath of projectInstructionFilePaths(rootPath)) {
    try {
      const contents = fs.readFileSync(filePath, "utf8");
      if (contents.includes(WIKI_INSTRUCTION_BLOCK_START)) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

function projectInstructionFilePaths(rootPath) {
  return PROJECT_INSTRUCTION_FILE_LAYOUTS.map((relativePath) => path.join(rootPath, relativePath));
}

function selectInstructionFilePath(rootPath) {
  const candidates = projectInstructionFilePaths(rootPath);
  const existingAgentsPath = candidates.find((filePath) => path.basename(filePath) === "AGENTS.md" && fs.existsSync(filePath));
  if (existingAgentsPath) {
    return existingAgentsPath;
  }

  const existingClaudePath = candidates.find((filePath) => path.basename(filePath) === "CLAUDE.md" && fs.existsSync(filePath));
  if (existingClaudePath) {
    return existingClaudePath;
  }

  return candidates[0];
}

function wikiInstructionBlock() {
  return [
    WIKI_INSTRUCTION_BLOCK_START,
    "## Project Wiki",
    "Maintain a durable, high-signal wiki under `.wiki/` for future agents.",
    "",
    "Use the wiki selectively:",
    "- Record durable knowledge such as hard-won debugging outcomes, stable commands and workflows, known issues, architecture notes, and decisions.",
    "- Prefer narrow, highly linked pages over broad dumping-ground pages.",
    "- Update the wiki at meaningful task boundaries when durable knowledge was produced.",
    "- Update durable pages automatically when useful. Only append explicit work-log style notes when the user says to \"file this\".",
    "- Trust code and raw sources over the wiki. If the wiki is stale or wrong, fix it first.",
    "- Cite relevant repo files, raw sources, and related wiki pages with markdown links when practical.",
    "- Never store secrets, credentials, or speculative claims as facts.",
    "- You may create, rename, or delete wiki pages whenever that makes the wiki more useful for agents.",
    "- Use `.wiki/staging/` for temporary synthesis that is not ready to become durable canon.",
    "",
    "Operational guidance:",
    "- Do not read the entire wiki by default on every task. Consult only the pages that seem relevant.",
    "- Skip wiki edits when nothing durable was learned.",
    "- Keep filler, repetition, and session-by-session narration out of the wiki.",
    "- Common pages like `known-issues.md` and `commands.md` are welcome when useful, but no fixed skeleton is required.",
    WIKI_INSTRUCTION_BLOCK_END
  ].join("\n");
}

function enableWiki(rootPath) {
  const wikiPath = wikiDirectoryPath(rootPath);
  fs.mkdirSync(path.join(wikiPath, WIKI_STAGING_DIRECTORY), { recursive: true });

  const instructionFilePath = selectInstructionFilePath(rootPath);
  const nextContents = upsertInstructionBlock(readTextFile(instructionFilePath));
  fs.mkdirSync(path.dirname(instructionFilePath), { recursive: true });
  fs.writeFileSync(instructionFilePath, nextContents, "utf8");

  return {
    wikiPath,
    instructionFilePath,
    enabled: true,
    exists: true
  };
}

function disableWiki(rootPath) {
  const touchedFiles = [];

  for (const instructionFilePath of projectInstructionFilePaths(rootPath)) {
    const contents = readTextFile(instructionFilePath);
    if (!contents.includes(WIKI_INSTRUCTION_BLOCK_START)) {
      continue;
    }

    fs.writeFileSync(instructionFilePath, removeInstructionBlock(contents), "utf8");
    touchedFiles.push(instructionFilePath);
  }

  return {
    wikiPath: wikiDirectoryPath(rootPath),
    instructionFilePaths: touchedFiles,
    enabled: false,
    exists: wikiExists(rootPath)
  };
}

function getWikiContext(rootPath, enabled) {
  const wikiPath = wikiDirectoryPath(rootPath);
  const exists = wikiExists(rootPath);

  return {
    enabled: !!enabled,
    exists,
    wikiPath,
    tree: exists ? buildWikiTree(wikiPath) : []
  };
}

function readWikiFile(rootPath, relativePath) {
  const wikiPath = wikiDirectoryPath(rootPath);
  const resolvedPath = path.resolve(wikiPath, relativePath || "");
  const normalizedWikiPath = `${path.resolve(wikiPath)}${path.sep}`;

  if (
    resolvedPath !== path.resolve(wikiPath) &&
    !resolvedPath.startsWith(normalizedWikiPath)
  ) {
    throw new Error("Wiki file path must stay inside .wiki.");
  }

  return {
    relativePath,
    absolutePath: resolvedPath,
    contents: fs.readFileSync(resolvedPath, "utf8")
  };
}

function buildWikiTree(wikiPath, currentPath = wikiPath) {
  let entries = [];

  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => !entry.name.startsWith(".DS_Store"))
    .sort(compareWikiEntries)
    .map((entry) => {
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = path.relative(wikiPath, absolutePath) || entry.name;

      if (entry.isDirectory()) {
        return {
          type: "directory",
          name: entry.name,
          relativePath,
          children: buildWikiTree(wikiPath, absolutePath)
        };
      }

      return {
        type: "file",
        name: entry.name,
        relativePath
      };
    });
}

function compareWikiEntries(left, right) {
  if (left.isDirectory() !== right.isDirectory()) {
    return left.isDirectory() ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}

function upsertInstructionBlock(contents) {
  const normalizedContents = normalizeFileContents(contents);
  const block = wikiInstructionBlock();

  if (!normalizedContents.trim()) {
    return `${block}\n`;
  }

  if (normalizedContents.includes(WIKI_INSTRUCTION_BLOCK_START)) {
    return `${removeInstructionBlock(normalizedContents)}\n\n${block}\n`;
  }

  return `${normalizedContents}\n\n${block}\n`;
}

function removeInstructionBlock(contents) {
  const normalizedContents = normalizeFileContents(contents);
  const pattern = new RegExp(
    `\\n*${escapeRegExp(WIKI_INSTRUCTION_BLOCK_START)}[\\s\\S]*?${escapeRegExp(WIKI_INSTRUCTION_BLOCK_END)}\\n*`,
    "g"
  );
  const stripped = normalizedContents.replace(pattern, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return stripped ? `${stripped}\n` : "";
}

function normalizeFileContents(contents) {
  return String(contents || "").replace(/\r\n/g, "\n").trimEnd();
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  WIKI_DIRECTORY_NAME,
  detectWikiEnabled,
  enableWiki,
  disableWiki,
  getWikiContext,
  readWikiFile,
  wikiDirectoryPath,
  wikiExists
};
