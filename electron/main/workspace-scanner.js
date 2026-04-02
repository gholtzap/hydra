const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const SKIPPED_DIRECTORIES = new Set([
  ".build",
  ".git",
  ".swiftpm",
  "DerivedData",
  "node_modules"
]);

function scanWorkspace(rootPath, workspaceId) {
  const normalizedRootPath = path.resolve(rootPath);
  const repoPaths = new Set();

  walk(normalizedRootPath, repoPaths);

  const repos = Array.from(repoPaths)
    .sort((left, right) => left.localeCompare(right))
    .map((repoPath) => createRepoRecord(repoPath, workspaceId));

  const rootHasGitDirectory = fs.existsSync(path.join(normalizedRootPath, ".git"));
  const containsRootAlready = repos.some((repo) => repo.path === normalizedRootPath);

  if ((rootHasGitDirectory || repos.length === 0) && !containsRootAlready) {
    repos.unshift(createRepoRecord(normalizedRootPath, workspaceId));
  }

  return repos;
}

function walk(currentPath, repoPaths) {
  let entries = [];

  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name === ".git") {
      repoPaths.add(path.resolve(currentPath));
      continue;
    }

    if (SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    walk(path.join(currentPath, entry.name), repoPaths);
  }
}

function createRepoRecord(repoPath, workspaceId) {
  return {
    id: randomUUID(),
    workspaceID: workspaceId,
    name: path.basename(repoPath) || repoPath,
    path: repoPath,
    discoveredAt: new Date().toISOString()
  };
}

module.exports = {
  scanWorkspace
};
