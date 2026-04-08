const fs = require("node:fs");
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
    : null;
const PLUGIN_ROOT = path.join(os.homedir(), ".claude", "plugins");

function buildClaudeSettingsContext(repo) {
  const homeDirectory = os.homedir();
  const globalFiles = filesFor(homeDirectory, "global", "Global");
  const projectFiles = repo ? filesFor(repo.path, "project", repo.name) : [];
  const resolvedValues = resolveValues(globalFiles, projectFiles);
  const settingsLayers = loadSettingsLayers(globalFiles, projectFiles);
  const plugins = buildPluginInventory(homeDirectory, settingsLayers);
  const { skills, skillRoots } = buildSkillInventory(homeDirectory, repo, plugins);

  return {
    globalFiles,
    projectFiles,
    resolvedValues,
    plugins,
    skills,
    skillRoots
  };
}

function loadSettingsFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function saveSettingsFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function normalizeAccessPath(filePath) {
  return typeof filePath === "string" && filePath.trim() ? path.resolve(filePath) : "";
}

function normalizeRepoPaths(repoPaths) {
  return Array.isArray(repoPaths)
    ? repoPaths
        .map((repoPath) => normalizeAccessPath(repoPath))
        .filter(Boolean)
    : [];
}

function isPathWithinRoot(filePath, rootPath) {
  const relativePath = path.relative(rootPath, filePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function isKnownSettingsLayoutPath(filePath, rootPath) {
  const normalizedRootPath = normalizeAccessPath(rootPath);
  if (!normalizedRootPath) {
    return false;
  }

  return FILE_LAYOUTS.some(([relativePath]) => path.join(normalizedRootPath, relativePath) === filePath);
}

function isSkillMarkdownPath(filePath, roots) {
  const baseName = path.basename(filePath);
  if (!SKILL_FILE_NAMES.includes(baseName) && baseName.toLowerCase() !== "skill.md") {
    return false;
  }

  return roots.some((rootPath) => isPathWithinRoot(filePath, rootPath));
}

function readableSkillRoots(repoPaths) {
  return [
    path.join(os.homedir(), ".claude", "skills"),
    ...normalizeRepoPaths(repoPaths).map((repoPath) => path.join(repoPath, ".claude", "skills")),
    MANAGED_SKILLS_ROOT,
    PLUGIN_ROOT
  ]
    .map((rootPath) => normalizeAccessPath(rootPath))
    .filter(Boolean);
}

function writableSkillRoots(repoPaths) {
  return [
    path.join(os.homedir(), ".claude", "skills"),
    ...normalizeRepoPaths(repoPaths).map((repoPath) => path.join(repoPath, ".claude", "skills"))
  ]
    .map((rootPath) => normalizeAccessPath(rootPath))
    .filter(Boolean);
}

function assertReadableClaudeSettingsFilePath(filePath, repoPaths = []) {
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

function assertWritableClaudeSettingsFilePath(filePath, repoPaths = []) {
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

function assertEditableClaudeSkillFilePath(filePath, repoPaths = []) {
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

function readClaudeSettingsFile(filePath, repoPaths = []) {
  return loadSettingsFile(assertReadableClaudeSettingsFilePath(filePath, repoPaths));
}

function writeClaudeSettingsFile(filePath, contents, repoPaths = []) {
  saveSettingsFile(assertWritableClaudeSettingsFilePath(filePath, repoPaths), contents);
}

function importSkillIcon(skillFilePath, sourceFilePath) {
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
  fs.mkdirSync(skillDirectoryPath, { recursive: true });
  fs.copyFileSync(sourceFilePath, targetFilePath);

  const relativeIconPath = `./${targetFileName}`;
  saveSettingsFile(skillFilePath, setFrontmatterValue(loadSettingsFile(skillFilePath), "icon", relativeIconPath));

  return targetFilePath;
}

function clearSkillIcon(skillFilePath) {
  if (!skillFilePath) {
    return false;
  }

  saveSettingsFile(skillFilePath, setFrontmatterValue(loadSettingsFile(skillFilePath), "icon", null));
  return true;
}

function filesFor(rootPath, scope, prefix) {
  return FILE_LAYOUTS.map(([relativePath, title]) => {
    const filePath = path.join(rootPath, relativePath);
    return {
      id: filePath,
      title: `${prefix} ${title}`,
      path: filePath,
      scope,
      exists: fs.existsSync(filePath)
    };
  });
}

function loadSettingsLayers(globalFiles, projectFiles) {
  return [...globalFiles, ...projectFiles]
    .filter((file) => file.exists && path.extname(file.path) === ".json")
    .map((file) => ({
      file,
      data: readJsonFile(file.path)
    }))
    .filter((entry) => isPlainObject(entry.data));
}

function resolveValues(globalFiles, projectFiles) {
  const precedence = loadSettingsLayers(globalFiles, projectFiles).map((entry) => entry.file);

  const valuesByKey = new Map();

  for (const file of precedence) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file.path, "utf8"));
      for (const [keyPath, valueSummary] of flatten(parsed)) {
        valuesByKey.set(keyPath, {
          id: keyPath,
          keyPath,
          valueSummary,
          sourceLabel: file.title
        });
      }
    } catch {
      continue;
    }
  }

  return Array.from(valuesByKey.values()).sort((left, right) =>
    left.keyPath.localeCompare(right.keyPath)
  );
}

function flatten(value, prefix = null) {
  if (Array.isArray(value)) {
    return [[prefix ?? "$", JSON.stringify(value)]];
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .flatMap((key) => {
        const nextPrefix = prefix ? `${prefix}.${key}` : key;
        return flatten(value[key], nextPrefix);
      });
  }

  return [[prefix ?? "$", stringify(value)]];
}

function stringify(value) {
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

function buildPluginInventory(homeDirectory, settingsLayers) {
  const installedPluginsPath = path.join(
    homeDirectory,
    ".claude",
    "plugins",
    "installed_plugins.json"
  );
  const installedPluginsData = readJsonFile(installedPluginsPath);
  const installedPlugins =
    isPlainObject(installedPluginsData) && isPlainObject(installedPluginsData.plugins)
      ? installedPluginsData.plugins
      : {};

  const effectivePlugins = resolveEnabledPlugins(settingsLayers);
  const pluginIds = new Set([
    ...Object.keys(installedPlugins),
    ...Array.from(effectivePlugins.values.keys())
  ]);

  return Array.from(pluginIds)
    .map((pluginId) => {
      const installedEntries = Array.isArray(installedPlugins[pluginId])
        ? installedPlugins[pluginId].filter(isPlainObject)
        : [];
      const activeInstall = latestInstalledEntry(installedEntries);
      const skillFiles = activeInstall?.installPath
        ? listSkillFiles(path.join(activeInstall.installPath, "skills"))
        : [];

      return {
        id: pluginId,
        name: pluginDisplayName(pluginId),
        marketplace: pluginMarketplace(pluginId),
        installed: !!activeInstall,
        enabled: effectivePlugins.values.get(pluginId) === true,
        enabledValue: effectivePlugins.values.has(pluginId)
          ? effectivePlugins.values.get(pluginId)
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
    .sort((left, right) => {
      if (left.enabled !== right.enabled) {
        return left.enabled ? -1 : 1;
      }
      if (left.installed !== right.installed) {
        return left.installed ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
}

function resolveEnabledPlugins(settingsLayers) {
  const values = new Map();
  const sources = new Map();

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

function latestInstalledEntry(entries) {
  if (!entries.length) {
    return null;
  }

  return [...entries].sort((left, right) => entryTimestamp(right) - entryTimestamp(left))[0];
}

function entryTimestamp(entry) {
  const value = entry?.lastUpdated || entry?.installedAt || "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildSkillInventory(homeDirectory, repo, plugins) {
  const userSkillsRoot = path.join(homeDirectory, ".claude", "skills");
  const projectSkillsRoot = repo ? path.join(repo.path, ".claude", "skills") : null;
  const managedSkillsRoot = MANAGED_SKILLS_ROOT;

  const projectSkills = projectSkillsRoot
    ? listSkillEntries(projectSkillsRoot, "project", repo?.name || "Project Skills", true)
    : [];
  const userSkills = listSkillEntries(userSkillsRoot, "user", "User Skills", true);
  const managedSkills = managedSkillsRoot
    ? listSkillEntries(managedSkillsRoot, "managed", "Managed Skills", false)
    : [];
  const pluginSkills = plugins
    .filter((plugin) => plugin.enabled && plugin.installPath)
    .flatMap((plugin) =>
      listSkillEntries(path.join(plugin.installPath, "skills"), "plugin", plugin.name, false, {
        pluginId: plugin.id
      })
    );

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

function listSkillEntries(
  rootPath,
  sourceType,
  sourceLabel,
  editable,
  extra: { pluginId?: string | null } = {}
) {
  return listSkillFiles(rootPath).map((filePath) => {
    const metadata = readSkillMetadata(filePath);

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
  });
}

function listSkillFiles(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return [];
  }

  try {
    return fs
      .readdirSync(rootPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => findSkillFile(path.join(rootPath, entry.name)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function findSkillFile(skillDirectoryPath) {
  for (const fileName of SKILL_FILE_NAMES) {
    const filePath = path.join(skillDirectoryPath, fileName);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  try {
    const fallback = fs
      .readdirSync(skillDirectoryPath)
      .find((fileName) => fileName.toLowerCase() === "skill.md");
    return fallback ? path.join(skillDirectoryPath, fallback) : null;
  } catch {
    return null;
  }
}

function readSkillMetadata(filePath) {
  const contents = loadSettingsFile(filePath);
  const frontmatter = parseFrontmatter(contents);
  const description = frontmatter.values.description || "";
  const iconReference = frontmatter.values.icon || "";
  const iconPath = resolveSkillIconPath(filePath, iconReference);

  return {
    description,
    iconPath,
    iconUrl: iconPath ? pathToFileURL(iconPath).href : ""
  };
}

function parseFrontmatter(contents) {
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

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
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

function resolveSkillIconPath(skillFilePath, iconReference) {
  if (!iconReference) {
    return "";
  }

  const iconPath = path.isAbsolute(iconReference)
    ? iconReference
    : path.resolve(path.dirname(skillFilePath), iconReference);

  return fs.existsSync(iconPath) ? iconPath : "";
}

function setFrontmatterValue(contents, key, nextValue) {
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

function stripYamlScalarQuotes(value) {
  return value.replace(/^["']|["']$/g, "");
}

function isSupportedSkillIconExtension(extension) {
  return new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]).has(extension);
}

function skillNameFromFile(filePath) {
  return path.basename(path.dirname(filePath));
}

function compareSkills(left, right) {
  const sourceOrder = skillSourceOrder(left.sourceType) - skillSourceOrder(right.sourceType);
  if (sourceOrder !== 0) {
    return sourceOrder;
  }

  return left.name.localeCompare(right.name);
}

function skillSourceOrder(sourceType) {
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

function pluginDisplayName(pluginId) {
  return humanizeIdentifier(pluginName(pluginId));
}

function pluginName(pluginId) {
  const markerIndex = pluginId.lastIndexOf("@");
  return markerIndex >= 0 ? pluginId.slice(0, markerIndex) : pluginId;
}

function pluginMarketplace(pluginId) {
  const markerIndex = pluginId.lastIndexOf("@");
  return markerIndex >= 0 ? pluginId.slice(markerIndex + 1) : "";
}

function humanizeIdentifier(value) {
  return String(value || "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isPlainObject(value) {
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
