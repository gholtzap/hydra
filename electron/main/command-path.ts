const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WELL_KNOWN_COMMAND_DIRECTORIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), ".opencode", "bin"),
  ...(process.platform === "win32"
    ? [
        process.env["SCOOP"] ? path.join(process.env["SCOOP"], "shims") : null,
        path.join(os.homedir(), "scoop", "shims")
      ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [])
];

async function resolveCommandPath(command: string, envPath?: string | null): Promise<string | null> {
  return resolveCommandPathSync(command, envPath);
}

function resolveCommandPathSync(command: string, envPath?: string | null): string | null {
  const normalizedCommand = typeof command === "string" ? command.trim() : "";
  if (!normalizedCommand) {
    return null;
  }

  if (path.isAbsolute(normalizedCommand)) {
    return isExecutableFile(normalizedCommand) ? normalizedCommand : null;
  }

  for (const directoryPath of commandSearchPaths(envPath)) {
    const candidatePath = path.join(directoryPath, normalizedCommand);
    if (isExecutableFile(candidatePath)) {
      return candidatePath;
    }
    if (process.platform === "win32") {
      for (const ext of [".exe", ".cmd", ".bat"]) {
        const candidateWithExt = candidatePath + ext;
        if (isExecutableFile(candidateWithExt)) {
          return candidateWithExt;
        }
      }
    }
  }

  return null;
}

function commandSearchPaths(envPath?: string | null): string[] {
  const configuredPath = typeof envPath === "string" ? envPath : "";
  const processPath = typeof process.env.PATH === "string" ? process.env.PATH : "";
  const directories = [
    ...configuredPath.split(path.delimiter),
    ...processPath.split(path.delimiter),
    ...WELL_KNOWN_COMMAND_DIRECTORIES
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set(directories));
}

function mergeCommandPath(envPath?: string | null): string {
  return commandSearchPaths(envPath).join(path.delimiter);
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (process.platform === "win32") {
      // On Windows, X_OK is meaningless. Check that file exists and has an executable extension.
      fs.accessSync(filePath, fs.constants.F_OK);
      const ext = path.extname(filePath).toLowerCase();
      return ext === ".exe" || ext === ".cmd" || ext === ".bat" || ext === ".com" || ext === ".ps1";
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  isExecutableFile,
  mergeCommandPath,
  resolveCommandPath,
  resolveCommandPathSync
};
