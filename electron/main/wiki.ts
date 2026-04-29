import type { WikiContext, WikiFileContents, WikiTreeNode } from "../shared-types";

const fs = require("node:fs");
const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
const path = require("node:path");

const WIKI_DIRECTORY_NAME = ".wiki";
const WIKI_STAGING_DIRECTORY = "staging";
const WIKI_INSTRUCTION_BLOCK_START = "<!-- claude-workspace:wiki:start -->";
const WIKI_INSTRUCTION_BLOCK_END = "<!-- claude-workspace:wiki:end -->";
const PROJECT_INSTRUCTION_FILE_LAYOUTS = ["AGENTS.md", "CLAUDE.md"];
const WIKI_EXISTS_SYNC_CACHE_TTL_MS = 5_000;
const WIKI_EXISTS_SYNC_CACHE_MAX_ENTRIES = 256;

type WikiExistsSyncCacheEntry = {
  exists: boolean;
  expiresAt: number;
  lastAccessedAt: number;
};

const wikiExistsSyncCache = new Map<string, WikiExistsSyncCacheEntry>();

function wikiDirectoryPath(rootPath: string): string {
  return path.join(rootPath, WIKI_DIRECTORY_NAME);
}

async function wikiExists(rootPath: string): Promise<boolean> {
  try {
    return (await fsp.stat(wikiDirectoryPath(rootPath))).isDirectory();
  } catch {
    return false;
  }
}

function wikiExistsSync(rootPath: string): boolean {
  const normalizedRootPath = path.resolve(rootPath);
  const currentTime = Date.now();
  pruneWikiExistsSyncCache(currentTime);

  const cachedEntry = wikiExistsSyncCache.get(normalizedRootPath);
  if (cachedEntry && cachedEntry.expiresAt > currentTime) {
    cachedEntry.lastAccessedAt = currentTime;
    return cachedEntry.exists;
  }

  wikiExistsSyncCache.delete(normalizedRootPath);

  try {
    return setCachedWikiExistsSyncResult(
      normalizedRootPath,
      fs.statSync(wikiDirectoryPath(normalizedRootPath)).isDirectory(),
      currentTime
    );
  } catch {
    return setCachedWikiExistsSyncResult(normalizedRootPath, false, currentTime);
  }
}

function setCachedWikiExistsSyncResult(rootPath: string, exists: boolean, currentTime = Date.now()): boolean {
  wikiExistsSyncCache.set(rootPath, {
    exists,
    expiresAt: currentTime + WIKI_EXISTS_SYNC_CACHE_TTL_MS,
    lastAccessedAt: currentTime
  });
  pruneWikiExistsSyncCache(currentTime);
  return exists;
}

function pruneWikiExistsSyncCache(currentTime = Date.now()): void {
  for (const [rootPath, entry] of wikiExistsSyncCache.entries()) {
    if (entry.expiresAt <= currentTime) {
      wikiExistsSyncCache.delete(rootPath);
    }
  }

  while (wikiExistsSyncCache.size > WIKI_EXISTS_SYNC_CACHE_MAX_ENTRIES) {
    let oldestRootPath = "";
    let oldestAccessedAt = Number.POSITIVE_INFINITY;

    for (const [rootPath, entry] of wikiExistsSyncCache.entries()) {
      if (entry.lastAccessedAt < oldestAccessedAt) {
        oldestRootPath = rootPath;
        oldestAccessedAt = entry.lastAccessedAt;
      }
    }

    if (!oldestRootPath) {
      break;
    }

    wikiExistsSyncCache.delete(oldestRootPath);
  }
}

function invalidateWikiExistsSyncCache(rootPath?: string): void {
  if (typeof rootPath === "string" && rootPath.trim()) {
    wikiExistsSyncCache.delete(path.resolve(rootPath));
    return;
  }

  wikiExistsSyncCache.clear();
}

async function detectWikiEnabled(rootPath: string): Promise<boolean> {
  for (const filePath of projectInstructionFilePaths(rootPath)) {
    const contents = await readTextFile(filePath);
    if (contents.includes(WIKI_INSTRUCTION_BLOCK_START)) {
      return true;
    }
  }

  return false;
}

function projectInstructionFilePaths(rootPath: string): string[] {
  return PROJECT_INSTRUCTION_FILE_LAYOUTS.map((relativePath) => path.join(rootPath, relativePath));
}

async function selectInstructionFilePath(rootPath: string): Promise<string> {
  const candidates = projectInstructionFilePaths(rootPath);

  for (const filePath of candidates) {
    if (path.basename(filePath) === "AGENTS.md" && (await pathExists(filePath))) {
      return filePath;
    }
  }

  for (const filePath of candidates) {
    if (path.basename(filePath) === "CLAUDE.md" && (await pathExists(filePath))) {
      return filePath;
    }
  }

  return candidates[0];
}

function wikiInstructionBlock(): string {
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

async function enableWiki(rootPath: string): Promise<{
  wikiPath: string;
  instructionFilePath: string;
  enabled: true;
  exists: true;
}> {
  const wikiPath = wikiDirectoryPath(rootPath);
  await fsp.mkdir(path.join(wikiPath, WIKI_STAGING_DIRECTORY), { recursive: true });

  const instructionFilePath = await selectInstructionFilePath(rootPath);
  const nextContents = upsertInstructionBlock(await readTextFile(instructionFilePath));
  await fsp.mkdir(path.dirname(instructionFilePath), { recursive: true });
  await fsp.writeFile(instructionFilePath, nextContents, "utf8");

  return {
    wikiPath,
    instructionFilePath,
    enabled: true,
    exists: true
  };
}

async function disableWiki(rootPath: string): Promise<{
  wikiPath: string;
  instructionFilePaths: string[];
  enabled: false;
  exists: boolean;
}> {
  const touchedFiles: string[] = [];

  for (const instructionFilePath of projectInstructionFilePaths(rootPath)) {
    const contents = await readTextFile(instructionFilePath);
    if (!contents.includes(WIKI_INSTRUCTION_BLOCK_START)) {
      continue;
    }

    await fsp.writeFile(instructionFilePath, removeInstructionBlock(contents), "utf8");
    touchedFiles.push(instructionFilePath);
  }

  return {
    wikiPath: wikiDirectoryPath(rootPath),
    instructionFilePaths: touchedFiles,
    enabled: false,
    exists: await wikiExists(rootPath)
  };
}

async function getWikiContext(rootPath: string, enabled: boolean): Promise<WikiContext> {
  const wikiPath = wikiDirectoryPath(rootPath);
  const exists = await wikiExists(rootPath);

  return {
    enabled: !!enabled,
    exists,
    wikiPath,
    tree: exists ? await buildWikiTree(wikiPath) : []
  };
}

async function readWikiFile(rootPath: string, relativePath: string): Promise<WikiFileContents> {
  const wikiPath = wikiDirectoryPath(rootPath);
  const resolvedWikiPath = path.resolve(wikiPath);
  const resolvedPath = path.resolve(wikiPath, relativePath || "");
  const normalizedWikiPath = `${resolvedWikiPath}${path.sep}`;

  if (
    resolvedPath !== resolvedWikiPath &&
    !resolvedPath.startsWith(normalizedWikiPath)
  ) {
    throw new Error("Wiki file path must stay inside .wiki.");
  }

  if (resolvedPath === resolvedWikiPath) {
    throw new Error("Wiki file path must point to a file inside .wiki.");
  }

  const stat = await fsp.stat(resolvedPath);
  if (stat.isDirectory()) {
    throw new Error("Wiki file path must point to a file inside .wiki.");
  }

  return {
    relativePath,
    absolutePath: resolvedPath,
    contents: await fsp.readFile(resolvedPath, "utf8")
  };
}

async function buildWikiTree(
  wikiPath: string,
  currentPath = wikiPath
): Promise<WikiTreeNode[]> {
  let entries: import("node:fs").Dirent[] = [];

  try {
    entries = await fsp.readdir(currentPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: WikiTreeNode[] = [];
  for (const entry of entries.filter((item) => !item.name.startsWith(".DS_Store")).sort(compareWikiEntries)) {
    const absolutePath = path.join(currentPath, entry.name);
    const relativePath = path.relative(wikiPath, absolutePath) || entry.name;

    if (entry.isDirectory()) {
      nodes.push({
        type: "directory",
        name: entry.name,
        relativePath,
        children: await buildWikiTree(wikiPath, absolutePath)
      });
      continue;
    }

    nodes.push({
      type: "file",
      name: entry.name,
      relativePath
    });
  }

  return nodes;
}

function compareWikiEntries(left: import("node:fs").Dirent, right: import("node:fs").Dirent): number {
  if (left.isDirectory() !== right.isDirectory()) {
    return left.isDirectory() ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}

function upsertInstructionBlock(contents: string): string {
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

function removeInstructionBlock(contents: string): string {
  const normalizedContents = normalizeFileContents(contents);
  const pattern = new RegExp(
    `\\n*${escapeRegExp(WIKI_INSTRUCTION_BLOCK_START)}[\\s\\S]*?${escapeRegExp(WIKI_INSTRUCTION_BLOCK_END)}\\n*`,
    "g"
  );
  const stripped = normalizedContents.replace(pattern, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return stripped ? `${stripped}\n` : "";
}

function normalizeFileContents(contents: string): string {
  return String(contents || "").replace(/\r\n/g, "\n").trimEnd();
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
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
  wikiExists,
  invalidateWikiExistsSyncCache,
  wikiExistsSync
};
