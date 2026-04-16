import type {
  ClaudePluginInventoryItem,
  ClaudeResolvedValue,
  ClaudeSettingsContext,
  ClaudeSettingsFileScope,
  ClaudeSettingsFileSummary,
  ClaudeSkillInventoryItem,
  ClaudeSkillRoots,
  ClaudeSkillSourceType,
  JsonObject,
  JsonValue
} from "../shared-types";

const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const FILE_LAYOUTS = [
  ["AGENTS.md", "AGENTS.md"],
  ["CLAUDE.md", "CLAUDE.md"],
  [path.join(".claude", "settings.json"), "settings.json"],
  [path.join(".claude", "settings.local.json"), "settings.local.json"]
];
const SKILL_FILE_NAMES = ["SKILL.md", "skill.md"];
const SKILL_ICON_BASENAME = "icon";
const MANAGED_SKILLS_ROOT =
  process.platform === "darwin"
    ? path.join(
        path.sep,
        "Library",
        "Application Support",
        "ClaudeCode",
        ".claude",
        "skills"
      )
    : process.platform === "win32"
    ? path.join(process.env["PROGRAMDATA"] || "C:\\ProgramData", "ClaudeCode", ".claude", "skills")
    : null;
const PLUGIN_ROOT = path.join(os.homedir(), ".claude", "plugins");

type RepoContext = { path: string; name: string } | null;
type SettingsLayer = { file: ClaudeSettingsFileSummary; data: JsonObject };
type EnabledPluginsResolution = { values: Map<string, boolean>; sources: Map<string, string> };
type InstalledPluginEntry = {
  installPath?: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
};

async function buildClaudeSettingsContext(repo: RepoContext): Promise<ClaudeSettingsContext> {
  const homeDirectory = os.homedir();
  const [globalFiles, projectFiles] = await Promise.all([
    filesFor(homeDirectory, "global", "Global"),
    repo ? filesFor(repo.path, "project", repo.name) : Promise.resolve([])
  ]);
  const settingsLayers = await loadSettingsLayers(globalFiles, projectFiles);
  const resolvedValues = resolveValues(settingsLayers);
  const plugins = await buildPluginInventory(homeDirectory, settingsLayers);
  const { skills, skillRoots } = await buildSkillInventory(homeDirectory, repo, plugins);

  return {
    globalFiles,
    projectFiles,
    resolvedValues,
    plugins,
    skills,
    skillRoots
  };
}

async function loadSettingsFile(filePath: string): Promise<string> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function saveSettingsFile(filePath: string, contents: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, contents, "utf8");
}

function normalizeAccessPath(filePath: unknown): string {
  return typeof filePath === "string" && filePath.trim() ? path.resolve(filePath) : "";
}

function normalizeRepoPaths(repoPaths: unknown): string[] {
  return Array.isArray(repoPaths)
    ? repoPaths
        .map((repoPath) => normalizeAccessPath(repoPath))
        .filter(Boolean)
    : [];
}

function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, filePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function isKnownSettingsLayoutPath(filePath: string, rootPath: string): boolean {
  const normalizedRootPath = normalizeAccessPath(rootPath);
  if (!normalizedRootPath) {
    return false;
  }

  return FILE_LAYOUTS.some(([relativePath]) => path.join(normalizedRootPath, relativePath) === filePath);
}

function isSkillMarkdownPath(filePath: string, roots: string[]): boolean {
  const baseName = path.basename(filePath);
  if (!SKILL_FILE_NAMES.includes(baseName) && baseName.toLowerCase() !== "skill.md") {
    return false;
  }

  return roots.some((rootPath) => isPathWithinRoot(filePath, rootPath));
}

function readableSkillRoots(repoPaths: unknown): string[] {
  return [
    path.join(os.homedir(), ".claude", "skills"),
    ...normalizeRepoPaths(repoPaths).map((repoPath) => path.join(repoPath, ".claude", "skills")),
    MANAGED_SKILLS_ROOT,
    PLUGIN_ROOT
  ]
    .map((rootPath) => normalizeAccessPath(rootPath))
    .filter(Boolean);
}

function writableSkillRoots(repoPaths: unknown): string[] {
  return [
    path.join(os.homedir(), ".claude", "skills"),
    ...normalizeRepoPaths(repoPaths).map((repoPath) => path.join(repoPath, ".claude", "skills"))
  ]
    .map((rootPath) => normalizeAccessPath(rootPath))
    .filter(Boolean);
}

function assertReadableClaudeSettingsFilePath(filePath: string, repoPaths: string[] = []): string {
  const normalizedFilePath = normalizeAccessPath(filePath);
  const normalizedRepoPaths = normalizeRepoPaths(repoPaths);
  if (!normalizedFilePath) {
    throw new Error("Settings path is required.");
  }

  if (
    isKnownSettingsLayoutPath(normalizedFilePath, os.homedir()) ||
    normalizedRepoPaths.some((repoPath) => isKnownSettingsLayoutPath(normalizedFilePath, repoPath)) ||
    isSkillMarkdownPath(normalizedFilePath, readableSkillRoots(normalizedRepoPaths))
  ) {
    return normalizedFilePath;
  }

  throw new Error("Settings access denied for the requested path.");
}

function assertWritableClaudeSettingsFilePath(filePath: string, repoPaths: string[] = []): string {
  const normalizedFilePath = normalizeAccessPath(filePath);
  const normalizedRepoPaths = normalizeRepoPaths(repoPaths);
  if (!normalizedFilePath) {
    throw new Error("Settings path is required.");
  }

  if (
    isKnownSettingsLayoutPath(normalizedFilePath, os.homedir()) ||
    normalizedRepoPaths.some((repoPath) => isKnownSettingsLayoutPath(normalizedFilePath, repoPath)) ||
    isSkillMarkdownPath(normalizedFilePath, writableSkillRoots(normalizedRepoPaths))
  ) {
    return normalizedFilePath;
  }

  throw new Error("Settings write denied for the requested path.");
}

function assertEditableClaudeSkillFilePath(filePath: string, repoPaths: string[] = []): string {
  const normalizedFilePath = normalizeAccessPath(filePath);
  const normalizedRepoPaths = normalizeRepoPaths(repoPaths);
  if (!normalizedFilePath) {
    throw new Error("Skill path is required.");
  }

  if (isSkillMarkdownPath(normalizedFilePath, writableSkillRoots(normalizedRepoPaths))) {
    return normalizedFilePath;
  }

  throw new Error("Skill updates are limited to user and project skills.");
}

async function readClaudeSettingsFile(filePath: string, repoPaths: string[] = []): Promise<string> {
  return loadSettingsFile(assertReadableClaudeSettingsFilePath(filePath, repoPaths));
}

async function writeClaudeSettingsFile(
  filePath: string,
  contents: string,
  repoPaths: string[] = []
): Promise<void> {
  await saveSettingsFile(assertWritableClaudeSettingsFilePath(filePath, repoPaths), contents);
}

async function importSkillIcon(skillFilePath: string, sourceFilePath: string): Promise<string | null> {
  if (!skillFilePath || !sourceFilePath) {
    return null;
  }

  const skillDirectoryPath = path.dirname(skillFilePath);
  const extension = path.extname(sourceFilePath).toLowerCase();
  if (!isSupportedSkillIconExtension(extension)) {
    throw new Error("Choose a PNG, JPG, GIF, SVG, or WebP image.");
  }

  const targetFileName = `${SKILL_ICON_BASENAME}${extension}`;
  const targetFilePath = path.join(skillDirectoryPath, targetFileName);
  await fsp.mkdir(skillDirectoryPath, { recursive: true });
  await fsp.copyFile(sourceFilePath, targetFilePath);

  const relativeIconPath = `./${targetFileName}`;
  const nextContents = setFrontmatterValue(
    await loadSettingsFile(skillFilePath),
    "icon",
    relativeIconPath
  );
  await saveSettingsFile(skillFilePath, nextContents);

  return targetFilePath;
}

async function clearSkillIcon(skillFilePath: string): Promise<boolean> {
  if (!skillFilePath) {
    return false;
  }

  const nextContents = setFrontmatterValue(await loadSettingsFile(skillFilePath), "icon", null);
  await saveSettingsFile(skillFilePath, nextContents);
  return true;
}

async function filesFor(
  rootPath: string,
  scope: ClaudeSettingsFileScope,
  prefix: string
): Promise<ClaudeSettingsFileSummary[]> {
  return Promise.all(
    FILE_LAYOUTS.map(async ([relativePath, title]) => {
      const filePath = path.join(rootPath, relativePath);
      return {
        id: filePath,
        title: `${prefix} ${title}`,
        path: filePath,
        scope,
        exists: await pathExists(filePath)
      };
    })
  );
}

async function loadSettingsLayers(
  globalFiles: ClaudeSettingsFileSummary[],
  projectFiles: ClaudeSettingsFileSummary[]
): Promise<SettingsLayer[]> {
  const entries = await Promise.all(
    [...globalFiles, ...projectFiles]
      .filter((file) => file.exists && path.extname(file.path) === ".json")
      .map(async (file) => ({
        file,
        data: await readJsonFile(file.path)
      }))
  );

  return entries.filter((entry): entry is SettingsLayer => isPlainObject(entry.data));
}

function resolveValues(
  settingsLayers: SettingsLayer[]
): ClaudeResolvedValue[] {
  const valuesByKey = new Map<string, ClaudeResolvedValue>();

  for (const { file, data } of settingsLayers) {
    for (const [keyPath, valueSummary] of flatten(data)) {
      valuesByKey.set(keyPath, {
        id: keyPath,
        keyPath,
        valueSummary,
        sourceLabel: file.title
      });
    }
  }

  return Array.from(valuesByKey.values()).sort((left, right) =>
    left.keyPath.localeCompare(right.keyPath)
  );
}

function flatten(value: unknown, prefix: string | null = null): Array<[string, string]> {
  if (Array.isArray(value)) {
    return [[prefix ?? "$", JSON.stringify(value)]];
  }

  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .flatMap((key) => {
        const nextPrefix = prefix ? `${prefix}.${key}` : key;
        return flatten(value[key], nextPrefix);
      });
  }

  return [[prefix ?? "$", stringify(value)]];
}

function stringify(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

async function buildPluginInventory(
  homeDirectory: string,
  settingsLayers: SettingsLayer[]
): Promise<ClaudePluginInventoryItem[]> {
  const installedPluginsPath = path.join(
    homeDirectory,
    ".claude",
    "plugins",
    "installed_plugins.json"
  );
  const installedPluginsData = await readJsonFile(installedPluginsPath);
  const installedPlugins =
    isPlainObject(installedPluginsData) && isPlainObject(installedPluginsData.plugins)
      ? installedPluginsData.plugins
      : {};

  const effectivePlugins = resolveEnabledPlugins(settingsLayers);
  const pluginIds = new Set([
    ...Object.keys(installedPlugins),
    ...Array.from(effectivePlugins.values.keys())
  ]);

  const pluginEntries = await Promise.all(
    Array.from(pluginIds).map(async (pluginId) => {
      const installedEntries = Array.isArray(installedPlugins[pluginId])
        ? installedPlugins[pluginId].filter(isPlainObject) as InstalledPluginEntry[]
        : [];
      const activeInstall = latestInstalledEntry(installedEntries);
      const skillFiles = activeInstall?.installPath
        ? await listSkillFiles(path.join(activeInstall.installPath, "skills"))
        : [];

      return {
        id: pluginId,
        name: pluginDisplayName(pluginId),
        marketplace: pluginMarketplace(pluginId),
        installed: !!activeInstall,
        enabled: effectivePlugins.values.get(pluginId) === true,
        enabledValue: effectivePlugins.values.has(pluginId)
          ? (effectivePlugins.values.get(pluginId) ?? null)
          : null,
        sourceLabel: effectivePlugins.sources.get(pluginId) || null,
        installPath: activeInstall?.installPath || null,
        version: activeInstall?.version || null,
        installedAt: activeInstall?.installedAt || null,
        lastUpdated: activeInstall?.lastUpdated || null,
        skillCount: skillFiles.length,
        skillNames: skillFiles.map((filePath) => skillNameFromFile(filePath))
      };
    })
  );

  return pluginEntries.sort((left, right) => {
    if (left.enabled !== right.enabled) {
      return left.enabled ? -1 : 1;
    }
    if (left.installed !== right.installed) {
      return left.installed ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function resolveEnabledPlugins(settingsLayers: SettingsLayer[]): EnabledPluginsResolution {
  const values = new Map<string, boolean>();
  const sources = new Map<string, string>();

  for (const { file, data } of settingsLayers) {
    if (!isPlainObject(data.enabledPlugins)) {
      continue;
    }

    for (const [pluginId, enabled] of Object.entries(data.enabledPlugins)) {
      if (typeof enabled !== "boolean") {
        continue;
      }

      values.set(pluginId, enabled);
      sources.set(pluginId, file.title);
    }
  }

  return { values, sources };
}

function latestInstalledEntry(entries: InstalledPluginEntry[]): InstalledPluginEntry | null {
  if (!entries.length) {
    return null;
  }

  return [...entries].sort((left, right) => entryTimestamp(right) - entryTimestamp(left))[0];
}

function entryTimestamp(entry: InstalledPluginEntry): number {
  const value = entry?.lastUpdated || entry?.installedAt || "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function buildSkillInventory(
  homeDirectory: string,
  repo: RepoContext,
  plugins: ClaudePluginInventoryItem[]
): Promise<{ skills: ClaudeSkillInventoryItem[]; skillRoots: ClaudeSkillRoots }> {
  const userSkillsRoot = path.join(homeDirectory, ".claude", "skills");
  const projectSkillsRoot = repo ? path.join(repo.path, ".claude", "skills") : null;
  const managedSkillsRoot = MANAGED_SKILLS_ROOT;

  const projectSkills = projectSkillsRoot
    ? await listSkillEntries(projectSkillsRoot, "project", repo?.name || "Project Skills", true)
    : [];
  const userSkills = await listSkillEntries(userSkillsRoot, "user", "User Skills", true);
  const managedSkills = managedSkillsRoot
    ? await listSkillEntries(managedSkillsRoot, "managed", "Managed Skills", false)
    : [];
  const pluginSkillGroups = await Promise.all(
    plugins
      .filter((plugin) => plugin.enabled && plugin.installPath)
      .map((plugin) =>
        listSkillEntries(path.join(plugin.installPath as string, "skills"), "plugin", plugin.name, false, {
          pluginId: plugin.id
        })
      )
  );
  const pluginSkills = pluginSkillGroups.flat();

  const skills = [...projectSkills, ...userSkills, ...managedSkills, ...pluginSkills].sort(
    compareSkills
  );

  return {
    skills,
    skillRoots: {
      user: userSkillsRoot,
      project: projectSkillsRoot,
      managed: managedSkillsRoot
    }
  };
}

async function listSkillEntries(
  rootPath: string,
  sourceType: ClaudeSkillSourceType,
  sourceLabel: string,
  editable: boolean,
  extra: { pluginId?: string | null } = {}
): Promise<ClaudeSkillInventoryItem[]> {
  const skillFiles = await listSkillFiles(rootPath);
  return Promise.all(
    skillFiles.map(async (filePath) => {
      const metadata = await readSkillMetadata(filePath);

      return {
        id: `${sourceType}:${filePath}`,
        name: skillNameFromFile(filePath),
        path: filePath,
        sourceType,
        sourceLabel,
        editable,
        description: metadata.description,
        iconPath: metadata.iconPath,
        iconUrl: metadata.iconUrl,
        pluginId: extra.pluginId || null
      };
    })
  );
}

async function listSkillFiles(rootPath: string): Promise<string[]> {
  if (!rootPath || !(await pathExists(rootPath))) {
    return [];
  }

  try {
    const entries = await fsp.readdir(rootPath, { withFileTypes: true });
    const resolvedPaths = await Promise.all(
      entries
        .filter((entry: import("node:fs").Dirent) => entry.isDirectory())
        .map((entry: import("node:fs").Dirent) => findSkillFile(path.join(rootPath, entry.name)))
    );
    return resolvedPaths.filter((resolvedPath: string | null): resolvedPath is string => !!resolvedPath);
  } catch {
    return [];
  }
}

async function findSkillFile(skillDirectoryPath: string): Promise<string | null> {
  for (const fileName of SKILL_FILE_NAMES) {
    const filePath = path.join(skillDirectoryPath, fileName);
    if (await pathExists(filePath)) {
      return filePath;
    }
  }

  try {
    const fallback = (await fsp.readdir(skillDirectoryPath))
      .find((fileName: string) => fileName.toLowerCase() === "skill.md");
    return fallback ? path.join(skillDirectoryPath, fallback) : null;
  } catch {
    return null;
  }
}

async function readSkillMetadata(
  filePath: string
): Promise<{ description: string; iconPath: string; iconUrl: string }> {
  const contents = await loadSettingsFile(filePath);
  const frontmatter = parseFrontmatter(contents);
  const description = frontmatter.values.description || "";
  const iconPath = await resolveSkillIconPath(filePath, frontmatter.values.icon || "");

  return {
    description,
    iconPath,
    iconUrl: iconPath ? pathToFileURL(iconPath).href : ""
  };
}

function parseFrontmatter(contents: string): {
  hasFrontmatter: boolean;
  lines: string[];
  values: Record<string, string>;
  body: string;
} {
  if (!contents.startsWith("---")) {
    return {
      hasFrontmatter: false,
      lines: [],
      values: {} as Record<string, string>,
      body: contents
    };
  }

  const lines = contents.split(/\r?\n/);
  if (lines[0].trim() !== "---") {
    return {
      hasFrontmatter: false,
      lines: [],
      values: {} as Record<string, string>,
      body: contents
    };
  }

  const closingIndex = lines.findIndex((line: string, index: number) => index > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    return {
      hasFrontmatter: false,
      lines: [],
      values: {} as Record<string, string>,
      body: contents
    };
  }

  const frontmatterLines = lines.slice(1, closingIndex);
  const values: Record<string, string> = {};

  for (const line of frontmatterLines) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    values[match[1]] = stripYamlScalarQuotes(match[2].trim());
  }

  return {
    hasFrontmatter: true,
    lines: frontmatterLines,
    values,
    body: lines.slice(closingIndex + 1).join("\n")
  };
}

async function resolveSkillIconPath(skillFilePath: string, iconReference: string): Promise<string> {
  if (!iconReference) {
    return "";
  }

  const iconPath = path.isAbsolute(iconReference)
    ? iconReference
    : path.resolve(path.dirname(skillFilePath), iconReference);

  return (await pathExists(iconPath)) ? iconPath : "";
}

function setFrontmatterValue(contents: string, key: string, nextValue: string | null): string {
  const parsed = parseFrontmatter(contents);
  const nextLine = nextValue === null ? null : `${key}: ${JSON.stringify(String(nextValue))}`;
  const nextLines = [...parsed.lines];
  const existingIndex = nextLines.findIndex((line) => line.startsWith(`${key}:`));

  if (existingIndex >= 0) {
    if (nextLine === null) {
      nextLines.splice(existingIndex, 1);
    } else {
      nextLines[existingIndex] = nextLine;
    }
  } else if (nextLine !== null) {
    nextLines.push(nextLine);
  }

  if (!parsed.hasFrontmatter && nextLine === null) {
    return contents;
  }

  const body = parsed.body.replace(/^\n+/, "");
  const frontmatterBlock = `---\n${nextLines.join("\n")}\n---`;

  if (!body) {
    return `${frontmatterBlock}\n`;
  }

  return `${frontmatterBlock}\n\n${body}`;
}

function stripYamlScalarQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function isSupportedSkillIconExtension(extension: string): boolean {
  return new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]).has(extension);
}

function skillNameFromFile(filePath: string): string {
  return path.basename(path.dirname(filePath));
}

function compareSkills(left: ClaudeSkillInventoryItem, right: ClaudeSkillInventoryItem): number {
  const sourceOrder = skillSourceOrder(left.sourceType) - skillSourceOrder(right.sourceType);
  if (sourceOrder !== 0) {
    return sourceOrder;
  }

  return left.name.localeCompare(right.name);
}

function skillSourceOrder(sourceType: ClaudeSkillSourceType): number {
  switch (sourceType) {
    case "project":
      return 0;
    case "user":
      return 1;
    case "managed":
      return 2;
    case "plugin":
      return 3;
    default:
      return 4;
  }
}

function pluginDisplayName(pluginId: string): string {
  return humanizeIdentifier(pluginName(pluginId));
}

function pluginName(pluginId: string): string {
  const markerIndex = pluginId.lastIndexOf("@");
  return markerIndex >= 0 ? pluginId.slice(0, markerIndex) : pluginId;
}

function pluginMarketplace(pluginId: string): string {
  const markerIndex = pluginId.lastIndexOf("@");
  return markerIndex >= 0 ? pluginId.slice(markerIndex + 1) : "";
}

function humanizeIdentifier(value: string): string {
  return String(value || "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return null;
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

function isPlainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  assertEditableClaudeSkillFilePath,
  assertReadableClaudeSettingsFilePath,
  buildClaudeSettingsContext,
  clearSkillIcon,
  importSkillIcon,
  readClaudeSettingsFile,
  writeClaudeSettingsFile
};
