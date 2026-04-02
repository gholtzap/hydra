const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FILE_LAYOUTS = [
  ["CLAUDE.md", "CLAUDE.md"],
  [path.join(".claude", "settings.json"), "settings.json"],
  [path.join(".claude", "settings.local.json"), "settings.local.json"]
];

function buildClaudeSettingsContext(repo) {
  const homeDirectory = os.homedir();
  const globalFiles = filesFor(homeDirectory, "global", "Global");
  const projectFiles = repo ? filesFor(repo.path, "project", repo.name) : [];
  const resolvedValues = resolveValues(globalFiles, projectFiles);

  return {
    globalFiles,
    projectFiles,
    resolvedValues
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

function resolveValues(globalFiles, projectFiles) {
  const precedence = [...globalFiles, ...projectFiles].filter(
    (file) => file.exists && path.extname(file.path) === ".json"
  );

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

module.exports = {
  buildClaudeSettingsContext,
  loadSettingsFile,
  saveSettingsFile
};
