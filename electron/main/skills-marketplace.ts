const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const GITHUB_API_ROOT = "https://api.github.com";
const GITHUB_RAW_ROOT = "https://raw.githubusercontent.com";
const USER_AGENT = "claude-workspace-skills-marketplace";
const REVIEWED_CATALOG = [
  {
    url: "https://github.com/vercel-labs/agent-skills/tree/main/skills/vercel-react-best-practices",
    tags: ["react", "nextjs", "performance"],
    reviewState: "reviewed"
  }
];

const repoInfoCache = new Map<string, Promise<any>>();
const repoTreeCache = new Map<string, Promise<any>>();
const skillMarkdownCache = new Map<string, Promise<string>>();

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function githubJson(endpoint: string) {
  const response = await fetch(`${GITHUB_API_ROOT}${endpoint}`, {
    headers: githubHeaders()
  });

  if (!response.ok) {
    const message = await readGithubError(response);
    throw new Error(message);
  }

  return response.json();
}

async function githubText(url: string) {
  const cacheKey = `text:${url}`;
  if (skillMarkdownCache.has(cacheKey)) {
    return skillMarkdownCache.get(cacheKey);
  }

  const task = (async () => {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub raw fetch failed (${response.status}) for ${url}`);
    }

    return response.text();
  })();

  skillMarkdownCache.set(cacheKey, task);
  return task;
}

async function githubBytes(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub raw fetch failed (${response.status}) for ${url}`);
  }

  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer);
}

async function readGithubError(response: Response) {
  try {
    const payload = await response.json();
    const message = payload?.message || `GitHub request failed (${response.status})`;
    if (response.status === 403 && /rate limit/i.test(message)) {
      return `${message}. Set GITHUB_TOKEN or GH_TOKEN to raise GitHub API limits.`;
    }

    return message;
  } catch {
    return `GitHub request failed (${response.status})`;
  }
}

function parseGitHubUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.hostname !== "github.com") {
    throw new Error("Use a github.com URL.");
  }

  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("GitHub URL must include an owner and repository.");
  }

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  let ref = "";
  let skillPath = "";

  if ((parts[2] === "tree" || parts[2] === "blob") && parts.length >= 4) {
    ref = decodeURIComponent(parts[3] || "");
    skillPath = parts.slice(4).map(decodeURIComponent).join("/");
  } else {
    skillPath = parts.slice(2).map(decodeURIComponent).join("/");
  }

  return {
    owner,
    repo,
    ref,
    skillPath
  };
}

function normalizePath(value: string) {
  return String(value || "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\\/g, "/");
}

function skillSourceKey(source: { owner: string; repo: string; ref: string; path: string }) {
  return `${source.owner}/${source.repo}@${source.ref}:${source.path}`;
}

function encodeGithubPathParts(value: string) {
  return normalizePath(value)
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function dirname(filePath: string) {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function basename(filePath: string) {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function isSkillFile(filePath: string) {
  const name = basename(filePath).toLowerCase();
  return name === "skill.md";
}

function isPathWithinRoot(filePath: string, rootPath: string) {
  const normalizedFile = normalizePath(filePath);
  const normalizedRoot = normalizePath(rootPath);
  return normalizedRoot
    ? normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`)
    : true;
}

function rawGithubUrl(source: { owner: string; repo: string; ref: string }, filePath: string) {
  const encodedSegments = encodeGithubPathParts(filePath);
  return `${GITHUB_RAW_ROOT}/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/${encodeURIComponent(source.ref)}/${encodedSegments}`;
}

function parseFrontmatter(contents: string) {
  if (!contents.startsWith("---")) {
    return {
      values: {} as Record<string, string>,
      body: contents
    };
  }

  const lines = contents.split(/\r?\n/);
  if (lines[0].trim() !== "---") {
    return {
      values: {} as Record<string, string>,
      body: contents
    };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    return {
      values: {} as Record<string, string>,
      body: contents
    };
  }

  const values: Record<string, string> = {};
  for (const line of lines.slice(1, closingIndex)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    values[match[1]] = stripYamlQuotes(match[2].trim());
  }

  return {
    values,
    body: lines.slice(closingIndex + 1).join("\n")
  };
}

function stripYamlQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

async function getRepoInfo(owner: string, repo: string) {
  const key = `${owner}/${repo}`;
  if (!repoInfoCache.has(key)) {
    repoInfoCache.set(
      key,
      githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
    );
  }

  return repoInfoCache.get(key);
}

async function getRepoTree(owner: string, repo: string, ref = "") {
  const repoInfo = await getRepoInfo(owner, repo);
  const resolvedRef = ref || repoInfo.default_branch || "main";
  const key = `${owner}/${repo}@${resolvedRef}`;

  if (!repoTreeCache.has(key)) {
    repoTreeCache.set(
      key,
      githubJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(resolvedRef)}?recursive=1`
      )
    );
  }

  const payload = await repoTreeCache.get(key);
  return {
    ref: resolvedRef,
    tree: Array.isArray(payload?.tree) ? payload.tree : []
  };
}

function findSkillRoots(treeEntries: any[]) {
  const roots = new Set<string>();

  for (const entry of treeEntries) {
    if (entry?.type !== "blob" || !isSkillFile(entry.path || "")) {
      continue;
    }

    roots.add(dirname(entry.path));
  }

  return Array.from(roots).sort();
}

function deriveTags(args: {
  catalogTags?: string[];
  repoTopics?: string[];
  skillPath: string;
  description: string;
  repoDescription: string;
}) {
  const tags = new Set<string>();
  const input = `${args.skillPath} ${args.description} ${args.repoDescription}`.toLowerCase();

  for (const tag of args.catalogTags || []) {
    if (tag) {
      tags.add(String(tag).toLowerCase());
    }
  }

  for (const topic of args.repoTopics || []) {
    if (topic) {
      tags.add(String(topic).toLowerCase());
    }
  }

  for (const keyword of [
    "react",
    "nextjs",
    "next.js",
    "typescript",
    "python",
    "swiftui",
    "design",
    "testing",
    "performance",
    "vercel"
  ]) {
    if (input.includes(keyword)) {
      tags.add(keyword.replace(".js", "js"));
    }
  }

  return Array.from(tags).slice(0, 6);
}

function deriveCompatibility(tags: string[], description: string) {
  const normalized = `${tags.join(" ")} ${description}`.toLowerCase();
  const matches = [];

  if (normalized.includes("nextjs") || normalized.includes("next.js")) {
    matches.push("Next.js");
  }
  if (normalized.includes("react")) {
    matches.push("React");
  }
  if (normalized.includes("typescript")) {
    matches.push("TypeScript");
  }
  if (normalized.includes("swiftui")) {
    matches.push("SwiftUI");
  }

  return matches.slice(0, 3);
}

function matchesSearch(value: string, query: string) {
  if (!query) {
    return true;
  }

  const normalizedValue = String(value || "").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => normalizedValue.includes(term));
}

async function buildSkillSummary(source: {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
  reviewState?: string;
  catalogTags?: string[];
}) {
  const repoInfo = await getRepoInfo(source.owner, source.repo);
  const repoTree = await getRepoTree(source.owner, source.repo, source.ref || "");
  const skillPath = normalizePath(source.path);
  const skillFiles = repoTree.tree.filter((entry) => entry?.type === "blob" && isPathWithinRoot(entry.path, skillPath));
  const skillFileEntry =
    skillFiles.find((entry) => normalizePath(entry.path) === `${skillPath}/SKILL.md`) ||
    skillFiles.find((entry) => normalizePath(entry.path) === `${skillPath}/skill.md`) ||
    skillFiles.find((entry) => isSkillFile(entry.path || ""));

  if (!skillFileEntry) {
    throw new Error(`No SKILL.md file was found in ${source.owner}/${source.repo}/${skillPath || "."}.`);
  }

  const resolvedSource = {
    owner: source.owner,
    repo: source.repo,
    ref: repoTree.ref,
    path: skillPath
  };
  const markdownUrl = rawGithubUrl(resolvedSource, skillFileEntry.path);
  const markdown = await githubText(markdownUrl);
  const frontmatter = parseFrontmatter(markdown);
  const description = frontmatter.values.description || repoInfo.description || "";
  const tags = deriveTags({
    catalogTags: source.catalogTags || [],
    repoTopics: Array.isArray(repoInfo.topics) ? repoInfo.topics : [],
    skillPath,
    description,
    repoDescription: repoInfo.description || ""
  });

  return {
    id: skillSourceKey(resolvedSource),
    source: resolvedSource,
    title: frontmatter.values.name || basename(skillPath) || basename(skillFileEntry.path).replace(/\.md$/i, ""),
    description,
    reviewState: source.reviewState || "unreviewed",
    sourceUrl: `https://github.com/${source.owner}/${source.repo}/tree/${repoTree.ref}/${encodeGithubPathParts(skillPath)}`,
    repoUrl: `https://github.com/${source.owner}/${source.repo}`,
    repoFullName: `${source.owner}/${source.repo}`,
    stars: Number(repoInfo.stargazers_count || 0),
    updatedAt: repoInfo.pushed_at || repoInfo.updated_at || "",
    tags,
    compatibility: deriveCompatibility(tags, description),
    fileCount: skillFiles.length,
    markdown,
    skillFilePath: normalizePath(skillFileEntry.path),
    files: skillFiles
      .map((entry) => ({
        path: normalizePath(entry.path),
        relativePath: normalizePath(entry.path).slice(skillPath.length + 1),
        size: Number(entry.size || 0)
      }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  };
}

async function searchReviewedCatalog(query: string) {
  const tasks = REVIEWED_CATALOG.map(async (entry) => {
    try {
      const parsed = parseGitHubUrl(entry.url);
      const summary = await buildSkillSummary({
        owner: parsed.owner,
        repo: parsed.repo,
        ref: parsed.ref || "main",
        path: parsed.skillPath,
        reviewState: entry.reviewState,
        catalogTags: entry.tags
      });
      const searchableText = `${summary.title} ${summary.description} ${summary.tags.join(" ")} ${summary.repoFullName}`;
      return matchesSearch(searchableText, query) ? summary : null;
    } catch {
      return null;
    }
  });

  const values = await Promise.all(tasks);
  return values.filter(Boolean);
}

async function searchGithubCode(query: string) {
  const trimmed = String(query || "").trim();
  if (trimmed.length < 2) {
    return [];
  }

  const queries = [
    `${trimmed} filename:SKILL.md`,
    `${trimmed} filename:skill.md`
  ];
  const payloads = await Promise.all(
    queries.map((value) =>
      githubJson(`/search/code?q=${encodeURIComponent(value)}&per_page=8`)
        .catch(() => ({ items: [] }))
    )
  );

  const roots = new Map<string, { owner: string; repo: string; path: string }>();

  for (const payload of payloads) {
    for (const item of payload?.items || []) {
      const owner = item?.repository?.owner?.login;
      const repo = item?.repository?.name;
      const filePath = normalizePath(item?.path || "");
      if (!owner || !repo || !isSkillFile(filePath)) {
        continue;
      }

      const skillPath = dirname(filePath);
      const key = `${owner}/${repo}:${skillPath}`;
      if (!roots.has(key)) {
        roots.set(key, {
          owner,
          repo,
          path: skillPath
        });
      }
    }
  }

  const tasks = Array.from(roots.values())
    .slice(0, 10)
    .map(async (entry) => {
      try {
        return await buildSkillSummary({
          owner: entry.owner,
          repo: entry.repo,
          path: entry.path,
          reviewState: "unreviewed"
        });
      } catch {
        return null;
      }
    });

  const values = await Promise.all(tasks);
  return values.filter(Boolean);
}

function summarizeSkill(summary: any) {
  return {
    id: summary.id,
    title: summary.title,
    description: summary.description,
    reviewState: summary.reviewState,
    sourceUrl: summary.sourceUrl,
    repoUrl: summary.repoUrl,
    repoFullName: summary.repoFullName,
    stars: summary.stars,
    updatedAt: summary.updatedAt,
    tags: summary.tags,
    compatibility: summary.compatibility,
    fileCount: summary.fileCount,
    source: summary.source
  };
}

async function searchMarketplaceSkills(payload: { query?: string }) {
  const query = String(payload?.query || "").trim();
  const [reviewed, unreviewed] = await Promise.all([
    searchReviewedCatalog(query),
    searchGithubCode(query)
  ]);
  const seen = new Set<string>();
  const results = [];

  for (const entry of [...reviewed, ...unreviewed].sort((left, right) => {
    if (left.reviewState !== right.reviewState) {
      return left.reviewState === "reviewed" ? -1 : 1;
    }

    if (left.stars !== right.stars) {
      return right.stars - left.stars;
    }

    return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  })) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    results.push(summarizeSkill(entry));
  }

  return {
    query,
    results
  };
}

async function getMarketplaceSkillDetails(payload: { source: { owner: string; repo: string; ref?: string; path: string; reviewState?: string; tags?: string[] } }) {
  const summary = await buildSkillSummary({
    owner: payload.source.owner,
    repo: payload.source.repo,
    ref: payload.source.ref || "",
    path: payload.source.path,
    reviewState: payload.source.reviewState || "unreviewed",
    catalogTags: payload.source.tags || []
  });

  return {
    ...summarizeSkill(summary),
    markdown: summary.markdown,
    files: summary.files,
    installTargets: {
      user: path.join(os.homedir(), ".claude", "skills"),
      project: payload?.source ? ".claude/skills" : null
    }
  };
}

async function inspectMarketplaceGitHubUrl(payload: { url: string }) {
  const parsed = parseGitHubUrl(payload.url);
  const repoTree = await getRepoTree(parsed.owner, parsed.repo, parsed.ref || "");
  const skillRoots = findSkillRoots(repoTree.tree);
  let matchingRoots = skillRoots;
  const requestedPath = normalizePath(parsed.skillPath);

  if (requestedPath) {
    matchingRoots = skillRoots.filter((root) =>
      root === requestedPath ||
      root.startsWith(`${requestedPath}/`) ||
      requestedPath.startsWith(`${root}/`)
    );
  }

  if (!matchingRoots.length) {
    throw new Error("No Claude-style skills were found at that GitHub URL.");
  }

  const results = await Promise.all(
    matchingRoots.slice(0, 12).map((skillPath) =>
      buildSkillSummary({
        owner: parsed.owner,
        repo: parsed.repo,
        ref: parsed.ref || repoTree.ref,
        path: skillPath,
        reviewState: "unreviewed"
      })
    )
  );

  return {
    results: results.map((entry) => summarizeSkill(entry))
  };
}

async function installMarketplaceSkill(payload: {
  source: { owner: string; repo: string; ref?: string; path: string };
  scope: "user" | "project";
  repoPath?: string | null;
}) {
  const scope = payload?.scope === "project" ? "project" : "user";
  const repoPath = payload?.repoPath || "";

  if (scope === "project" && !repoPath) {
    throw new Error("Open a project folder before installing a project-scoped skill.");
  }

  const summary = await buildSkillSummary({
    owner: payload.source.owner,
    repo: payload.source.repo,
    ref: payload.source.ref || "",
    path: payload.source.path,
    reviewState: "unreviewed"
  });
  const rootPath =
    scope === "project"
      ? path.join(repoPath, ".claude", "skills")
      : path.join(os.homedir(), ".claude", "skills");
  const skillDirectoryName = basename(summary.source.path) || summary.title;
  const installPath = path.join(rootPath, skillDirectoryName);

  try {
    await fs.access(installPath);
    throw new Error(`${skillDirectoryName} already exists at ${installPath}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(installPath, { recursive: true });

  try {
    for (const file of summary.files) {
      const targetPath = path.join(installPath, file.relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const contents = await githubBytes(rawGithubUrl(summary.source, file.path));
      await fs.writeFile(targetPath, contents);
    }
  } catch (error) {
    await fs.rm(installPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    installed: true,
    installPath,
    scope,
    skillName: skillDirectoryName,
    sourceUrl: summary.sourceUrl
  };
}

module.exports = {
  searchMarketplaceSkills,
  getMarketplaceSkillDetails,
  inspectMarketplaceGitHubUrl,
  installMarketplaceSkill
};
