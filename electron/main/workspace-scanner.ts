import type { RepoRecord } from "../shared-types";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeRepoParallelWorktreeSettings } = require("./state-store") as {
  normalizeRepoParallelWorktreeSettings: (value: unknown) => RepoRecord["parallelWorktreeSettings"];
};
const { detectWikiEnabled } = require("./wiki") as {
  detectWikiEnabled: (rootPath: string) => Promise<boolean>;
};

async function scanWorkspace(rootPath: string, workspaceId: string): Promise<RepoRecord[]> {
  const normalizedRootPath = path.resolve(rootPath);
  return [await createRepoRecord(normalizedRootPath, workspaceId)];
}

async function createRepoRecord(repoPath: string, workspaceId: string): Promise<RepoRecord> {
  return {
    id: randomUUID(),
    workspaceID: workspaceId,
    name: path.basename(repoPath) || repoPath,
    path: repoPath,
    wikiEnabled: await detectWikiEnabled(repoPath),
    appLaunchConfig: null,
    parallelWorktreeSettings: normalizeRepoParallelWorktreeSettings({}),
    parallelWorktreeLedger: [],
    discoveredAt: new Date().toISOString()
  };
}

module.exports = {
  scanWorkspace
};
