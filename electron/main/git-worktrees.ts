const { execFile, spawnSync } = require("node:child_process") as typeof import("node:child_process");
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

function hasUntrackedFilesSync(repoPath: string): boolean {
  const result = runGitSync(["status", "--porcelain", "--untracked-files=all"], repoPath);
  if (!result.ok) {
    return false;
  }

  return result.stdout
    .split(/\r?\n/)
    .some((line) => line.startsWith("?? "));
}

async function listChangedFiles(repoPath: string, baseBranch: string): Promise<string[]> {
  const fileSet = new Set<string>();
  const trimmedBaseBranch = typeof baseBranch === "string" ? baseBranch.trim() : "";

  const commands: string[][] = [
    ["diff", "--name-only", "--diff-filter=ACMR"],
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    ["ls-files", "--others", "--exclude-standard"]
  ];

  if (trimmedBaseBranch) {
    commands.unshift(["diff", "--name-only", "--diff-filter=ACMR", `${trimmedBaseBranch}...HEAD`]);
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

  return [...fileSet].sort((left, right) => left.localeCompare(right));
}

async function readCurrentBranch(repoPath: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  if (!result.ok) {
    return null;
  }

  const normalized = result.stdout.trim();
  return normalized && normalized !== "HEAD" ? normalized : null;
}

async function listGitWorktrees(repoPath: string): Promise<ListedWorktree[]> {
  const result = await runGit(["worktree", "list", "--porcelain"], repoPath);
  if (!result.ok) {
    return [];
  }

  const entries: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;

  for (const rawLine of result.stdout.split(/\r?\n/)) {
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
  const resolvedCandidate = path.resolve(candidatePath);
  const worktrees = await listGitWorktrees(repoPath);
  return worktrees.some((entry) => path.resolve(entry.path) === resolvedCandidate);
}

module.exports = {
  hasUntrackedFilesSync,
  listChangedFiles,
  listGitWorktrees,
  readCurrentBranch,
  validateWorktreePath
};
