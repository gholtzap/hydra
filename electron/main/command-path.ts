const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WELL_KNOWN_COMMAND_DIRECTORIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  path.join(os.homedir(), ".local", "bin")
];

async function resolveCommandPath(command: string): Promise<string | null> {
  const normalizedCommand = typeof command === "string" ? command.trim() : "";
  if (!normalizedCommand) {
    return null;
  }

  if (path.isAbsolute(normalizedCommand)) {
    return isExecutableFile(normalizedCommand) ? normalizedCommand : null;
  }

  for (const directoryPath of commandSearchPaths()) {
    const candidatePath = path.join(directoryPath, normalizedCommand);
    if (isExecutableFile(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

function commandSearchPaths(): string[] {
  const envPath = typeof process.env.PATH === "string" ? process.env.PATH : "";
  const directories = [
    ...envPath.split(path.delimiter),
    ...WELL_KNOWN_COMMAND_DIRECTORIES
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set(directories));
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  isExecutableFile,
  resolveCommandPath
};
