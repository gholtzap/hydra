#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const VALID_BUMPS = new Set(["patch", "minor", "major"]);
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const MAIN_BRANCH = "main";

function run(command, args, options = {}) {
  const { capture = true } = options;
  const result = execFileSync(command, args, {
    cwd: repoRoot(),
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });

  if (!capture) {
    return "";
  }

  return result.trim();
}

function repoRoot() {
  return process.cwd();
}

function parseArgs(argv) {
  const options = {
    bump: "patch",
    dryRun: false,
    noPush: false,
    prepare: false
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--no-push") {
      options.noPush = true;
      continue;
    }
    if (arg === "--prepare") {
      options.prepare = true;
      continue;
    }
    if (VALID_BUMPS.has(arg) || VERSION_PATTERN.test(arg)) {
      options.bump = arg;
      continue;
    }

    throw new Error(
      `Unsupported argument: ${arg}\nUsage: npm run release -- [patch|minor|major|x.y.z] [--dry-run] [--no-push] [--prepare]`
    );
  }

  return options;
}

function readPackageJson() {
  const packageJsonPath = path.join(repoRoot(), "package.json");
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
}

function parseVersion(rawVersion) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(rawVersion).trim());
  if (!match) {
    throw new Error(`Invalid version: ${rawVersion}`);
  }

  return {
    raw: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function compareVersions(left, right) {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function maxVersion(left, right) {
  return compareVersions(left, right) >= 0 ? left : right;
}

function incrementVersion(version, bump) {
  if (bump === "major") {
    return { raw: `${version.major + 1}.0.0`, major: version.major + 1, minor: 0, patch: 0 };
  }
  if (bump === "minor") {
    return { raw: `${version.major}.${version.minor + 1}.0`, major: version.major, minor: version.minor + 1, patch: 0 };
  }

  return { raw: `${version.major}.${version.minor}.${version.patch + 1}`, major: version.major, minor: version.minor, patch: version.patch + 1 };
}

function latestReleaseTag() {
  const tagsOutput = run("git", ["tag", "--list", "--sort=-v:refname", "v*"]);
  const latestTag = tagsOutput.split("\n").map((value) => value.trim()).find(Boolean);
  return latestTag || null;
}

function tagExists(tagName) {
  try {
    run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tagName}`]);
    return true;
  } catch {
    return false;
  }
}

function currentBranch() {
  const branchName = run("git", ["branch", "--show-current"]);
  if (!branchName) {
    throw new Error("Release script requires a named branch, not a detached HEAD.");
  }
  return branchName;
}

function isMainBranch(branchName) {
  return branchName === MAIN_BRANCH;
}

function isWorktreeClean() {
  const status = run("git", ["status", "--short"]);
  return !status;
}

function worktreeEntries() {
  const status = run("git", ["status", "--short"]);
  if (!status) {
    return [];
  }

  return status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      raw: line,
      path: line.slice(3).trim()
    }));
}

function formatWorktreeEntries(entries) {
  return entries.map((entry) => `- ${entry.raw}`).join("\n");
}

function isRecoverablePreparedReleaseState(entries) {
  if (!entries.length) {
    return false;
  }

  const allowedPaths = new Set(["package.json", "package-lock.json"]);
  return entries.every((entry) => allowedPaths.has(entry.path));
}

function originReleaseUrl() {
  try {
    const remoteUrl = run("git", ["remote", "get-url", "origin"]);
    const httpsMatch = /^https:\/\/github\.com\/([^/]+\/[^/.]+?)(?:\.git)?$/.exec(remoteUrl);
    if (httpsMatch) {
      return `https://github.com/${httpsMatch[1]}/releases`;
    }

    const sshMatch = /^git@github\.com:([^/]+\/[^/.]+?)(?:\.git)?$/.exec(remoteUrl);
    if (sshMatch) {
      return `https://github.com/${sshMatch[1]}/releases`;
    }
  } catch {}

  return null;
}

function resolveTargetVersion(packageVersion, latestTagVersion, requestedBump) {
  if (VERSION_PATTERN.test(requestedBump)) {
    return parseVersion(requestedBump);
  }

  if (!latestTagVersion) {
    return packageVersion;
  }

  if (latestTagVersion && compareVersions(packageVersion, latestTagVersion) > 0) {
    return packageVersion;
  }

  return incrementVersion(maxVersion(packageVersion, latestTagVersion || packageVersion), requestedBump);
}

function publishCommandFor(options, targetVersion) {
  if (VALID_BUMPS.has(options.bump)) {
    return `npm run release:${options.bump}`;
  }

  return `npm run release -- ${targetVersion.raw}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const pkg = readPackageJson();
  const packageVersion = parseVersion(pkg.version);
  const latestTag = latestReleaseTag();
  const latestTagVersion = latestTag ? parseVersion(latestTag) : null;
  const targetVersion = resolveTargetVersion(packageVersion, latestTagVersion, options.bump);
  const targetTag = `v${targetVersion.raw}`;
  const branchName = currentBranch();
  const shouldBumpPackageVersion = targetVersion.raw !== packageVersion.raw;
  const entries = worktreeEntries();
  const worktreeClean = entries.length === 0;
  const preparedReleaseState =
    latestTagVersion !== null &&
    compareVersions(packageVersion, latestTagVersion) > 0 &&
    isRecoverablePreparedReleaseState(entries);
  const shouldCommitPreparedVersion = preparedReleaseState;
  const requiresReleaseCommit = shouldBumpPackageVersion || shouldCommitPreparedVersion;
  const publishCommand = publishCommandFor(options, targetVersion);

  if (tagExists(targetTag)) {
    throw new Error(`Tag ${targetTag} already exists.`);
  }

  if (options.dryRun) {
    console.log(`Mode: ${options.prepare ? "prepare" : "publish"}`);
    console.log(`Branch: ${branchName}`);
    console.log(`Package version: ${packageVersion.raw}`);
    console.log(`Latest tag: ${latestTag || "(none)"}`);
    console.log(`Next release version: ${targetVersion.raw}`);
    console.log(`Will bump package version: ${shouldBumpPackageVersion ? "yes" : "no"}`);
    console.log(`Prepared release state: ${preparedReleaseState ? "yes" : "no"}`);
    console.log(`Worktree clean: ${worktreeClean ? "yes" : "no"}`);
    if (!worktreeClean) {
      console.log("Worktree changes:");
      console.log(formatWorktreeEntries(entries));
    }
    console.log(`Will push branch: ${options.noPush ? "no" : "yes"}`);
    console.log(`Will create tag: ${options.prepare ? "no" : "yes"}`);
    return;
  }

  if (!worktreeClean && !preparedReleaseState) {
    throw new Error(
      `Worktree is not clean. Commit or stash changes before running the release script.\n${formatWorktreeEntries(entries)}`
    );
  }

  if (options.prepare && isMainBranch(branchName)) {
    throw new Error(
      `Release preparation must run on a branch, not ${MAIN_BRANCH}.\n` +
        `Create a short-lived branch from ${MAIN_BRANCH}, run ${publishCommand} -- --prepare there, ` +
        `open a pull request, merge it, then rerun ${publishCommand} from an up-to-date ${MAIN_BRANCH} to publish ${targetTag}.`
    );
  }

  if (options.prepare && !requiresReleaseCommit) {
    throw new Error(
      `Nothing to prepare for ${targetTag}. package.json is already aligned with the release tag.\n` +
        `Switch to an up-to-date ${MAIN_BRANCH} checkout and run ${publishCommand} to publish the tag.`
    );
  }

  if (!options.prepare && !isMainBranch(branchName)) {
    throw new Error(
      `Release publishing must run from ${MAIN_BRANCH}. You are on ${branchName}.\n` +
        `Use ${publishCommand} -- --prepare on this branch, merge the release pull request, ` +
        `then rerun ${publishCommand} from an up-to-date ${MAIN_BRANCH}.`
    );
  }

  if (!options.prepare && requiresReleaseCommit) {
    throw new Error(
      `Protected ${MAIN_BRANCH} requires a release pull request before publishing ${targetTag}.\n` +
        `1. Create a short-lived branch from ${MAIN_BRANCH}.\n` +
        `2. Run ${publishCommand} -- --prepare on that branch.\n` +
        `3. Open and merge the release pull request.\n` +
        `4. Sync local ${MAIN_BRANCH} and rerun ${publishCommand} to push tag ${targetTag}.`
    );
  }

  if (shouldBumpPackageVersion) {
    run("npm", ["version", targetVersion.raw, "--no-git-tag-version"], { capture: false });
    run("git", ["add", "package.json", "package-lock.json"], { capture: false });
    run("git", ["commit", "-m", `Release ${targetTag}`], { capture: false });
  } else if (shouldCommitPreparedVersion) {
    run("git", ["add", "package.json", "package-lock.json"], { capture: false });
    run("git", ["commit", "-m", `Release ${targetTag}`], { capture: false });
  }

  if (options.prepare) {
    if (!options.noPush) {
      run("git", ["push", "origin", branchName], { capture: false });
    }

    console.log(`Prepared ${targetTag} on ${branchName}`);
    console.log(`Open a pull request into ${MAIN_BRANCH}, merge it, sync local ${MAIN_BRANCH}, then run ${publishCommand}.`);
    return;
  }

  if (!options.noPush) {
    run("git", ["push", "origin", branchName], { capture: false });
  }

  run("git", ["tag", targetTag], { capture: false });

  if (!options.noPush) {
    run("git", ["push", "origin", targetTag], { capture: false });
  }

  console.log(`Released ${targetTag}`);
  const releasesUrl = originReleaseUrl();
  if (releasesUrl) {
    console.log(`Releases: ${releasesUrl}`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
