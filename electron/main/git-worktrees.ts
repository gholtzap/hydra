import type { WorktreeChangeStats } from "../shared-types";

const { execFile, spawnSync } = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

type GitExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

type ListedWorktree = {
  path: string;
  branch: string | null;
};

type WorktreeChangeSummary = {
  files: string[];
  stats: WorktreeChangeStats;
};

async function runGit(args: string[], cwd: string): Promise<GitExecResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        const exitCode =
          typeof error?.code === "number"
            ? error.code
            : error
              ? 1
              : 0;
        resolve({
          ok: !error,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          exitCode
        });
      }
    );
  });
}

function runGitSync(args: string[], cwd: string): GitExecResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });

  return {
    ok: !result.error && result.status === 0,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : result.error?.message || "",
    exitCode: typeof result.status === "number" ? result.status : 1
  };
}

function canonicalPathSync(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function createWorktreeSync(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string
): GitExecResult {
  try {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error || ""),
      exitCode: 1
    };
  }

  return runGitSync(["worktree", "add", "-b", branchName, worktreePath, baseBranch], repoPath);
}

function listBranchesSync(repoPath: string): string[] {
  const result = runGitSync(["for-each-ref", "--format=%(refname:short)", "refs/heads"], repoPath);
  if (!result.ok) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !!line)
    .sort((left, right) => left.localeCompare(right));
}

function parseNumstat(stdout: string): WorktreeChangeStats {
  const stats: WorktreeChangeStats = {
    files: 0,
    additions: 0,
    deletions: 0
  };

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const [additions, deletions] = line.split(/\t/);
    stats.files += 1;
    if (additions !== "-") {
      const count = Number(additions);
      if (Number.isFinite(count) && count > 0) {
        stats.additions += count;
      }
    }
    if (deletions !== "-") {
      const count = Number(deletions);
      if (Number.isFinite(count) && count > 0) {
        stats.deletions += count;
      }
    }
  }

  return stats;
}

function addChangeStats(target: WorktreeChangeStats, next: WorktreeChangeStats): void {
  target.files += next.files;
  target.additions += next.additions;
  target.deletions += next.deletions;
}

async function countUntrackedFileAdditions(repoPath: string, filePath: string): Promise<number> {
  try {
    const absolutePath = path.resolve(repoPath, filePath);
    const stat = await fs.promises.stat(absolutePath);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      return 0;
    }

    const content = await fs.promises.readFile(absolutePath, "utf8");
    if (!content) {
      return 0;
    }

    const lines = content.split(/\r?\n/);
    return content.endsWith("\n") ? lines.length - 1 : lines.length;
  } catch {
    return 0;
  }
}

async function listWorktreeChanges(repoPath: string, baseBranch: string): Promise<WorktreeChangeSummary> {
  const fileSet = new Set<string>();
  const trimmedBaseBranch = typeof baseBranch === "string" ? baseBranch.trim() : "";
  const stats: WorktreeChangeStats = {
    files: 0,
    additions: 0,
    deletions: 0
  };

  const commands: string[][] = [
    ["diff", "--name-only", "--diff-filter=ACMRD"],
    ["diff", "--cached", "--name-only", "--diff-filter=ACMRD"],
    ["ls-files", "--others", "--exclude-standard"]
  ];
  const numstatCommands: string[][] = [
    ["diff", "--numstat", "--diff-filter=ACMRD"],
    ["diff", "--cached", "--numstat", "--diff-filter=ACMRD"]
  ];

  if (trimmedBaseBranch) {
    commands.unshift(["diff", "--name-only", "--diff-filter=ACMRD", `${trimmedBaseBranch}...HEAD`]);
    numstatCommands.unshift(["diff", "--numstat", "--diff-filter=ACMRD", `${trimmedBaseBranch}...HEAD`]);
  }

  const results = await Promise.all(commands.map((args) => runGit(args, repoPath)));
  for (const result of results) {
    if (!result.ok) {
      continue;
    }

    for (const line of result.stdout.split(/\r?\n/)) {
      const normalized = line.trim();
      if (normalized) {
        fileSet.add(normalized);
      }
    }
  }

  const numstatResults = await Promise.all(numstatCommands.map((args) => runGit(args, repoPath)));
  for (const result of numstatResults) {
    if (result.ok) {
      addChangeStats(stats, parseNumstat(result.stdout));
    }
  }

  const untrackedFiles = results[results.length - 1]?.ok
    ? results[results.length - 1].stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => !!line)
    : [];
  if (untrackedFiles.length) {
    stats.files += untrackedFiles.length;
    const additions = await Promise.all(
      untrackedFiles.map((filePath) => countUntrackedFileAdditions(repoPath, filePath))
    );
    stats.additions += additions.reduce((sum, count) => sum + count, 0);
  }

  const files = [...fileSet].sort((left, right) => left.localeCompare(right));
  stats.files = files.length || stats.files;

  return { files, stats };
}

async function readCurrentBranch(repoPath: string): Promise<string | null> {
  const { ok, stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  if (!ok) {
    return null;
  }

  const normalized = stdout.trim();
  return normalized && normalized !== "HEAD" ? normalized : null;
}

function readCurrentBranchSync(repoPath: string): string | null {
  const { ok, stdout } = runGitSync(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  if (!ok) {
    return null;
  }

  const normalized = stdout.trim();
  return normalized && normalized !== "HEAD" ? normalized : null;
}

async function listGitWorktrees(repoPath: string): Promise<ListedWorktree[]> {
  const { ok, stdout } = await runGit(["worktree", "list", "--porcelain"], repoPath);
  if (!ok) {
    return [];
  }

  return parseListedWorktrees(stdout);
}

function listGitWorktreesSync(repoPath: string): ListedWorktree[] {
  const { ok, stdout } = runGitSync(["worktree", "list", "--porcelain"], repoPath);
  if (!ok) {
    return [];
  }

  return parseListedWorktrees(stdout);
}

function parseListedWorktrees(output: string): ListedWorktree[] {
  const entries: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current?.path) {
        entries.push(current);
      }
      current = null;
      continue;
    }

    if (line.startsWith("worktree ")) {
      if (current?.path) {
        entries.push(current);
      }
      current = {
        path: line.slice("worktree ".length).trim(),
        branch: null
      };
      continue;
    }

    if (line.startsWith("branch ") && current) {
      const branchRef = line.slice("branch ".length).trim();
      current.branch = branchRef.replace(/^refs\/heads\//, "") || null;
    }
  }

  if (current?.path) {
    entries.push(current);
  }

  return entries;
}

async function validateWorktreePath(repoPath: string, candidatePath: string): Promise<boolean> {
  const resolvedCandidate = canonicalPathSync(candidatePath);
  const worktrees = await listGitWorktrees(repoPath);
  return worktrees.some((entry) => canonicalPathSync(entry.path) === resolvedCandidate);
}

function validateWorktreePathSync(repoPath: string, candidatePath: string): boolean {
  const resolvedCandidate = canonicalPathSync(candidatePath);
  const worktrees = listGitWorktreesSync(repoPath);
  return worktrees.some((entry) => canonicalPathSync(entry.path) === resolvedCandidate);
}

function deleteWorktreeSync(repoPath: string, worktreePath: string): GitExecResult {
  const resolvedWorktreePath = canonicalPathSync(worktreePath);
  const knownWorktree = listGitWorktreesSync(repoPath).some(
    (entry) => canonicalPathSync(entry.path) === resolvedWorktreePath
  );

  if (!knownWorktree) {
    runGitSync(["worktree", "prune"], repoPath);
    return {
      ok: true,
      stdout: "",
      stderr: "",
      exitCode: 0
    };
  }

  const result = runGitSync(["worktree", "remove", "--force", resolvedWorktreePath], repoPath);
  if (result.ok) {
    runGitSync(["worktree", "prune"], repoPath);
  }
  return result;
}

function isWorktreeDirtySync(worktreePath: string): boolean {
  const result = runGitSync(["status", "--porcelain", "--untracked-files=all"], worktreePath);
  if (!result.ok) {
    return true;
  }

  return result.stdout.trim().length > 0;
}

function resolveCommitSync(repoPath: string, refName: string): string | null {
  const result = runGitSync(["rev-parse", "--verify", refName], repoPath);
  if (!result.ok) {
    return null;
  }

  return result.stdout.trim() || null;
}

function successfulResult(stdout = ""): GitExecResult {
  return {
    ok: true,
    stdout,
    stderr: "",
    exitCode: 0
  };
}

function failedResult(stderr: string, exitCode = 1): GitExecResult {
  return {
    ok: false,
    stdout: "",
    stderr,
    exitCode
  };
}

function fastForwardWorktreeToBranchSync(
  repoPath: string,
  worktreePath: string,
  targetBranch: string
): GitExecResult {
  const normalizedBranch = typeof targetBranch === "string" ? targetBranch.trim() : "";
  if (!normalizedBranch || !listBranchesSync(repoPath).includes(normalizedBranch)) {
    return failedResult("Choose an existing local branch.");
  }

  if (!validateWorktreePathSync(repoPath, worktreePath)) {
    return failedResult("Hydra could not find that Git worktree.");
  }

  if (isWorktreeDirtySync(worktreePath)) {
    return failedResult("Commit or discard worktree changes before pushing to a branch.");
  }

  const sourceCommit = resolveCommitSync(worktreePath, "HEAD");
  const targetCommit = resolveCommitSync(repoPath, `refs/heads/${normalizedBranch}`);
  if (!sourceCommit || !targetCommit) {
    return failedResult("Hydra could not resolve the source or target branch.");
  }

  if (sourceCommit === targetCommit) {
    return successfulResult("Branch is already up to date.");
  }

  const ancestorCheck = runGitSync(["merge-base", "--is-ancestor", targetCommit, sourceCommit], worktreePath);
  if (!ancestorCheck.ok) {
    return failedResult(`${normalizedBranch} cannot be fast-forwarded to this worktree branch.`);
  }

  const currentRepoBranch = readCurrentBranchSync(repoPath);
  if (currentRepoBranch === normalizedBranch) {
    return runGitSync(["merge", "--ff-only", sourceCommit], repoPath);
  }

  const resolvedWorktreePath = canonicalPathSync(worktreePath);
  const resolvedRepoPath = canonicalPathSync(repoPath);
  const checkedOutElsewhere = listGitWorktreesSync(repoPath).find(
    (entry) =>
      entry.branch === normalizedBranch &&
      canonicalPathSync(entry.path) !== resolvedWorktreePath &&
      canonicalPathSync(entry.path) !== resolvedRepoPath
  );
  if (checkedOutElsewhere) {
    return failedResult(`${normalizedBranch} is checked out at ${checkedOutElsewhere.path}.`);
  }

  return runGitSync(["branch", "-f", normalizedBranch, sourceCommit], repoPath);
}

module.exports = {
  createWorktreeSync,
  deleteWorktreeSync,
  fastForwardWorktreeToBranchSync,
  listBranchesSync,
  listWorktreeChanges,
  listGitWorktrees,
  listGitWorktreesSync,
  readCurrentBranch,
  readCurrentBranchSync,
  validateWorktreePath,
  validateWorktreePathSync
};
