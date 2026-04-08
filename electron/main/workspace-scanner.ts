import type { RepoRecord } from "../shared-types";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { detectWikiEnabled } = require("./wiki");

function scanWorkspace(rootPath: string, workspaceId: string): RepoRecord[] {
  const normalizedRootPath = path.resolve(rootPath);
  return [createRepoRecord(normalizedRootPath, workspaceId)];
}

function createRepoRecord(repoPath: string, workspaceId: string): RepoRecord {
  return {
    id: randomUUID(),
    workspaceID: workspaceId,
    name: path.basename(repoPath) || repoPath,
    path: repoPath,
    wikiEnabled: detectWikiEnabled(repoPath),
    discoveredAt: new Date().toISOString()
  };
}

module.exports = {
  scanWorkspace
};
