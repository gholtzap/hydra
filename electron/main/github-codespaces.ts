import type {
  GitHubCliStatus,
  GitHubCodespaceDefaults,
  GitHubCodespaceLifecycleAction,
  GitHubCodespaceListItem,
  GitHubCodespaceListResult,
  GitHubCodespaceMachine,
  GitHubCodespaceMachineListResult,
  GitHubBranchListItem,
  GitHubBranchListResult,
  GitHubRepositoryListItem,
  GitHubRepositoryListResult,
  GitHubNativeAuthStatus
} from "../shared-types";
import type { ExecFileException } from "node:child_process";

const { execFile } = require("node:child_process") as typeof import("node:child_process");
const { resolveCommandPathSync } = require("./command-path") as {
  resolveCommandPathSync: (command: string, envPath?: string | null) => string | null;
};
const {
  gitHubNativeAccessToken,
  gitHubNativeAuthStatus
} = require("./github-native-auth") as {
  gitHubNativeAccessToken: (requiredScope?: string) => Promise<string | null>;
  gitHubNativeAuthStatus: () => Promise<GitHubNativeAuthStatus>;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RawCodespace = {
  name?: unknown;
  displayName?: unknown;
  display_name?: unknown;
  repository?: unknown;
  state?: unknown;
  machineName?: unknown;
  machine?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  lastUsedAt?: unknown;
  last_used_at?: unknown;
};

type RawMachine = {
  name?: unknown;
  display_name?: unknown;
  displayName?: unknown;
  operating_system?: unknown;
  operatingSystem?: unknown;
  storage_in_bytes?: unknown;
  storageBytes?: unknown;
  memory_in_bytes?: unknown;
  memoryBytes?: unknown;
  cpus?: unknown;
};

type RawRepository = {
  nameWithOwner?: unknown;
  full_name?: unknown;
  isPrivate?: unknown;
  private?: unknown;
  defaultBranchRef?: unknown;
  default_branch?: unknown;
};

type RawBranch = {
  name?: unknown;
  protected?: unknown;
};

const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CODESPACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BRANCH_PATTERN = /^[^\s~^:?*[\\\]](?:[^\s~^:?*[\\\]]|\/(?!\.))*$/;
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

async function githubCliStatus(): Promise<GitHubCliStatus> {
  const ghPath = resolveCommandPathSync("gh");
  if (!ghPath) {
    return {
      installed: false,
      authenticated: false,
      account: null,
      scopes: [],
      error: "Install GitHub CLI, then run gh auth login."
    };
  }

  const result = await runCommand(ghPath, ["auth", "status", "--hostname", "github.com"], 15_000);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;

  if (result.exitCode !== 0) {
    return {
      installed: true,
      authenticated: false,
      account: parseAccount(combinedOutput),
      scopes: parseScopes(combinedOutput),
      error: cleanCommandError(result) || "Authenticate GitHub CLI with gh auth login."
    };
  }

  return {
    installed: true,
    authenticated: true,
    account: parseAccount(combinedOutput),
    scopes: parseScopes(combinedOutput),
    error: null
  };
}

async function listGitHubCodespaces(repository?: string | null): Promise<GitHubCodespaceListResult> {
  const auth = await codespaceApiAuth();
  if (auth.error) {
    return {
      ok: false,
      status: auth.status,
      codespaces: [],
      error: auth.error
    };
  }

  const normalizedRepository = normalizeRepository(repository);
  let apiPath = "/user/codespaces?per_page=100";
  if (normalizedRepository) {
    const [owner, repo] = normalizedRepository.split("/");
    apiPath = `/repos/${owner}/${repo}/codespaces?per_page=100`;
  }

  const result = await runGitHubApi(apiPath, {}, 30_000);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      status: auth.status,
      codespaces: [],
      error: cleanCommandError(result) || "GitHub API could not list codespaces."
    };
  }

  return {
    ok: true,
    status: auth.status,
    codespaces: parseCodespaces(result.stdout),
    error: null
  };
}

async function listGitHubRepositories(): Promise<GitHubRepositoryListResult> {
  const auth = await generalGitHubApiAuth();
  if (auth.error) {
    return {
      ok: false,
      status: auth.status,
      repositories: [],
      error: auth.error
    };
  }

  const result = auth.nativeReady
    ? await runGitHubApi("/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member", {}, 30_000)
    : await runGitHubCliRepoList(30_000);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      status: auth.status,
      repositories: [],
      error: cleanCommandError(result) || "GitHub CLI could not list repositories."
    };
  }

  return {
    ok: true,
    status: auth.status,
    repositories: parseRepositories(result.stdout),
    error: null
  };
}

async function listGitHubBranches(repository: string): Promise<GitHubBranchListResult> {
  const auth = await generalGitHubApiAuth();
  if (auth.error) {
    return {
      ok: false,
      status: auth.status,
      branches: [],
      error: auth.error
    };
  }

  const normalizedRepository = requireRepository(repository);
  const [owner, repo] = normalizedRepository.split("/");
  const result = await runGitHubApi(`/repos/${owner}/${repo}/branches?per_page=100`, {}, 30_000);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      status: auth.status,
      branches: [],
      error: cleanCommandError(result) || "GitHub CLI could not list branches."
    };
  }

  return {
    ok: true,
    status: auth.status,
    branches: parseBranches(result.stdout),
    error: null
  };
}

async function listGitHubCodespaceMachines(
  repository: string
): Promise<GitHubCodespaceMachineListResult> {
  const auth = await codespaceApiAuth();
  if (auth.error) {
    return {
      ok: false,
      status: auth.status,
      machines: [],
      error: auth.error
    };
  }

  const normalizedRepository = requireRepository(repository);
  const [owner, repo] = normalizedRepository.split("/");
  const result = await runGitHubApi(`/repos/${owner}/${repo}/codespaces/machines`, {}, 30_000);

  if (result.exitCode !== 0) {
    return {
      ok: false,
      status: auth.status,
      machines: [],
      error: cleanCommandError(result) || "GitHub CLI could not list Codespaces machines."
    };
  }

  return {
    ok: true,
    status: auth.status,
    machines: parseMachines(result.stdout),
    error: null
  };
}

async function gitHubCodespaceDefaults(repoPath: string): Promise<GitHubCodespaceDefaults> {
  const gitPath = resolveCommandPathSync("git");
  if (!gitPath) {
    return {
      repository: null,
      branch: null,
      error: "Git is not available on PATH."
    };
  }

  const [remoteResult, branchResult] = await Promise.all([
    runCommand(gitPath, ["-C", repoPath, "remote", "get-url", "origin"], 10_000),
    runCommand(gitPath, ["-C", repoPath, "branch", "--show-current"], 10_000)
  ]);

  const repository = remoteResult.exitCode === 0 ? parseGitHubRemote(remoteResult.stdout.trim()) : null;
  const branch = branchResult.exitCode === 0 ? normalizeBranch(branchResult.stdout.trim()) : null;

  return {
    repository,
    branch: branch || "main",
    error: repository ? null : "Set a GitHub origin remote or enter owner/repo manually."
  };
}

async function createGitHubCodespace(input: {
  repository: string;
  branch: string;
  machine?: string;
  displayName?: string;
}): Promise<GitHubCodespaceListItem> {
  const auth = await codespaceApiAuth();
  if (auth.error) {
    throw new Error(auth.error);
  }

  const repository = requireRepository(input.repository);
  const branch = requireBranch(input.branch);
  const displayName = normalizeDisplayName(input.displayName) || defaultDisplayName(repository);
  const [owner, repo] = repository.split("/");
  const fields: Record<string, string> = {
    ref: branch,
    display_name: displayName
  };
  const machine = normalizeMachine(input.machine);
  if (machine) {
    fields.machine = machine;
  }

  const createResult = await runGitHubApi(`/repos/${owner}/${repo}/codespaces`, {
    method: "POST",
    fields
  }, 120_000);
  if (createResult.exitCode !== 0) {
    throw new Error(cleanCommandError(createResult) || "GitHub API could not create the codespace.");
  }

  const created = parseCodespace(createResult.stdout);
  if (created) {
    return created;
  }

  const listResult = await listGitHubCodespaces(repository);
  if (!listResult.ok) {
    throw new Error(listResult.error || "Codespace was created, but Hydra could not find it.");
  }

  const matchingCodespace = listResult.codespaces.find((codespace) => codespace.displayName === displayName);
  if (matchingCodespace) {
    return matchingCodespace;
  }

  const fallback = listResult.codespaces[0];
  if (fallback) {
    return fallback;
  }

  throw new Error("Codespace was created, but GitHub API returned no matching codespaces.");
}

async function disconnectGitHubCli(): Promise<GitHubCliStatus> {
  const status = await githubCliStatus();
  if (!status.installed || !status.account) {
    return status;
  }

  const ghPath = resolveCommandPathSync("gh");
  if (!ghPath) {
    return {
      installed: false,
      authenticated: false,
      account: null,
      scopes: [],
      error: "Install GitHub CLI, then run gh auth login."
    };
  }

  const result = await runCommand(
    ghPath,
    ["auth", "logout", "--hostname", "github.com", "--user", status.account],
    15_000
  );
  if (result.exitCode !== 0) {
    throw new Error(cleanCommandError(result) || "GitHub CLI could not sign out.");
  }

  return githubCliStatus();
}

async function signInGitHubCli(): Promise<GitHubCliStatus> {
  const ghPath = resolveCommandPathSync("gh");
  if (!ghPath) {
    return {
      installed: false,
      authenticated: false,
      account: null,
      scopes: [],
      error: "Install GitHub CLI, then sign in again."
    };
  }

  const before = await githubCliStatus();
  if (before.authenticated) {
    return before;
  }

  const result = await runCommand(
    ghPath,
    [
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--web",
      "--git-protocol",
      "https",
      "--skip-ssh-key",
      "--scopes",
      "codespace"
    ],
    180_000
  );
  if (result.exitCode !== 0) {
    throw new Error(cleanCommandError(result) || "GitHub CLI sign-in did not complete.");
  }

  return githubCliStatus();
}

async function refreshGitHubCliCodespaceScope(): Promise<GitHubCliStatus> {
  const status = await githubCliStatus();
  if (!status.installed || !status.authenticated) {
    return signInGitHubCli();
  }
  if (hasCodespaceScope(status)) {
    return status;
  }

  const ghPath = resolveCommandPathSync("gh");
  if (!ghPath) {
    return {
      installed: false,
      authenticated: false,
      account: null,
      scopes: [],
      error: "Install GitHub CLI, then sign in again."
    };
  }

  const result = await runCommand(
    ghPath,
    ["auth", "refresh", "--hostname", "github.com", "--scopes", "codespace"],
    180_000
  );
  if (result.exitCode !== 0) {
    throw new Error(cleanCommandError(result) || "GitHub CLI scope refresh did not complete.");
  }

  return githubCliStatus();
}

async function manageGitHubCodespace(
  codespaceName: string,
  action: GitHubCodespaceLifecycleAction
): Promise<void> {
  const auth = await codespaceApiAuth();
  if (auth.error) {
    throw new Error(auth.error);
  }

  const name = validateCodespaceName(codespaceName);
  const result = await runGitHubApiForLifecycle(name, action);
  if (result.exitCode !== 0) {
    throw new Error(cleanCommandError(result) || `GitHub CLI could not ${action} the codespace.`);
  }
}

async function runGitHubApiForLifecycle(
  name: string,
  action: GitHubCodespaceLifecycleAction
): Promise<CommandResult> {
  if (action === "start") {
    return runGitHubApi(`/user/codespaces/${encodeURIComponent(name)}/start`, {
      method: "POST",
      silent: true
    }, codespaceLifecycleTimeoutMs(action));
  }
  if (action === "stop") {
    return runGitHubApi(`/user/codespaces/${encodeURIComponent(name)}/stop`, {
      method: "POST",
      silent: true
    }, codespaceLifecycleTimeoutMs(action));
  }
  if (action === "delete") {
    return runGitHubApi(`/user/codespaces/${encodeURIComponent(name)}`, {
      method: "DELETE",
      silent: true
    }, codespaceLifecycleTimeoutMs(action));
  }
  const ghPath = resolveCommandPathSync("gh");
  if (!ghPath) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Install GitHub CLI to rebuild Codespaces."
    };
  }
  if (action === "rebuild") {
    return runCommand(ghPath, ["codespace", "rebuild", "--codespace", name], codespaceLifecycleTimeoutMs(action));
  }
  if (action === "fullRebuild") {
    return runCommand(ghPath, ["codespace", "rebuild", "--codespace", name, "--full"], codespaceLifecycleTimeoutMs(action));
  }
  throw new Error("Choose a valid GitHub Codespace action.");
}

function codespaceLifecycleTimeoutMs(action: GitHubCodespaceLifecycleAction): number {
  return action === "rebuild" || action === "fullRebuild" ? 600_000 : 60_000;
}

function validateCodespaceName(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!CODESPACE_NAME_PATTERN.test(normalized)) {
    throw new Error("Choose a valid GitHub Codespace.");
  }
  return normalized;
}

function normalizeRepository(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return GITHUB_REPOSITORY_PATTERN.test(normalized) ? normalized : null;
}

function requireRepository(value: unknown): string {
  const repository = normalizeRepository(value);
  if (!repository) {
    throw new Error("Enter a GitHub repository as owner/repo.");
  }
  return repository;
}

function normalizeBranch(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.includes("..") || normalized.endsWith("/") || normalized.endsWith(".")) {
    return null;
  }
  return BRANCH_PATTERN.test(normalized) ? normalized : null;
}

function requireBranch(value: unknown): string {
  const branch = normalizeBranch(value);
  if (!branch) {
    throw new Error("Enter a valid branch name.");
  }
  return branch;
}

function normalizeMachine(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return null;
  }
  return /^[A-Za-z0-9_.:-]+$/.test(normalized) ? normalized : null;
}

function normalizeDisplayName(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return normalized ? normalized.slice(0, 48) : null;
}

function defaultDisplayName(repository: string): string {
  const repoName = repository.split("/")[1] || repository;
  const suffix = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
  return `Hydra ${repoName} ${suffix}`.slice(0, 48);
}

function parseGitHubRemote(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return normalizeRepository(`${sshMatch[1]}/${sshMatch[2].replace(/\.git$/, "")}`);
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
      return null;
    }
    const pathParts = parsed.pathname.replace(/^\/|\.git$/g, "").split("/");
    if (pathParts.length < 2) {
      return null;
    }
    return normalizeRepository(`${pathParts[0]}/${pathParts[1]}`);
  } catch {
    return null;
  }
}

function parseCodespaces(stdout: string): GitHubCodespaceListItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  const codespaceValues = isRecord(parsed) && Array.isArray(parsed.codespaces)
    ? parsed.codespaces
    : Array.isArray(parsed)
      ? parsed
      : [];

  return codespaceValues
    .map((value): GitHubCodespaceListItem | null => codespaceFromValue(value))
    .filter((value): value is GitHubCodespaceListItem => value !== null);
}

function parseCodespace(stdout: string): GitHubCodespaceListItem | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  return codespaceFromValue(parsed);
}

function codespaceFromValue(value: unknown): GitHubCodespaceListItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const raw = value as RawCodespace;
  const name = stringValue(raw.name);
  const repository = repositoryValue(raw.repository);
  if (!name || !repository) {
    return null;
  }
  return {
    name,
    displayName: stringValue(raw.displayName) || stringValue(raw.display_name),
    repository,
    state: stringValue(raw.state) || "unknown",
    machineName: stringValue(raw.machineName) || machineNameValue(raw.machine),
    createdAt: stringValue(raw.createdAt) || stringValue(raw.created_at),
    lastUsedAt: stringValue(raw.lastUsedAt) || stringValue(raw.last_used_at)
  };
}

function parseMachines(stdout: string): GitHubCodespaceMachine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  const machineValues = isRecord(parsed) && Array.isArray(parsed.machines)
    ? parsed.machines
    : Array.isArray(parsed)
      ? parsed
      : [];

  return machineValues
    .map((value): GitHubCodespaceMachine | null => {
      if (!isRecord(value)) {
        return null;
      }
      const raw = value as RawMachine;
      const name = stringValue(raw.name);
      if (!name) {
        return null;
      }
      return {
        name,
        displayName: stringValue(raw.display_name) || stringValue(raw.displayName) || name,
        operatingSystem: stringValue(raw.operating_system) || stringValue(raw.operatingSystem),
        storageBytes: numberValue(raw.storage_in_bytes) ?? numberValue(raw.storageBytes),
        memoryBytes: numberValue(raw.memory_in_bytes) ?? numberValue(raw.memoryBytes),
        cpus: numberValue(raw.cpus)
      };
    })
    .filter((value): value is GitHubCodespaceMachine => value !== null);
}

function parseRepositories(stdout: string): GitHubRepositoryListItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((value): GitHubRepositoryListItem | null => {
      if (!isRecord(value)) {
        return null;
      }
      const raw = value as RawRepository;
      const nameWithOwner = stringValue(raw.nameWithOwner) || stringValue(raw.full_name);
      const repository = normalizeRepository(nameWithOwner);
      if (!repository) {
        return null;
      }
      return {
        nameWithOwner: repository,
        isPrivate: raw.isPrivate === true || raw.private === true,
        defaultBranch: defaultBranchName(raw.defaultBranchRef) || stringValue(raw.default_branch)
      };
    })
    .filter((value): value is GitHubRepositoryListItem => value !== null);
}

function parseBranches(stdout: string): GitHubBranchListItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((value): GitHubBranchListItem | null => {
      if (!isRecord(value)) {
        return null;
      }
      const raw = value as RawBranch;
      const name = stringValue(raw.name);
      if (!name) {
        return null;
      }
      return {
        name,
        protected: raw.protected === true
      };
    })
    .filter((value): value is GitHubBranchListItem => value !== null);
}

function defaultBranchName(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return stringValue(value.name);
}

function repositoryValue(value: unknown): string | null {
  if (typeof value === "string") {
    return normalizeRepository(value);
  }
  if (!isRecord(value)) {
    return null;
  }
  const nameWithOwner = stringValue(value.nameWithOwner);
  if (nameWithOwner) {
    return normalizeRepository(nameWithOwner);
  }
  const owner = isRecord(value.owner) ? stringValue(value.owner.login) : stringValue(value.owner);
  const name = stringValue(value.name);
  return owner && name ? normalizeRepository(`${owner}/${name}`) : null;
}

function machineNameValue(value: unknown): string | null {
  if (typeof value === "string") {
    return stringValue(value);
  }
  if (!isRecord(value)) {
    return null;
  }
  return stringValue(value.name);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseAccount(output: string): string | null {
  return output.match(/account\s+([A-Za-z0-9-]+)/)?.[1] || null;
}

function parseScopes(output: string): string[] {
  const match = output.match(/Token scopes:\s+'([^']*)'/);
  if (!match) {
    return [];
  }
  return match[1].split(",").map((scope) => scope.trim()).filter(Boolean);
}

function hasCodespaceScope(status: GitHubCliStatus): boolean {
  return status.scopes.length === 0 || status.scopes.includes("codespace");
}

function hasNativeCodespaceScope(status: GitHubNativeAuthStatus): boolean {
  return status.scopes.length === 0 || status.scopes.includes("codespace");
}

type GitHubApiAuth = {
  status: GitHubCliStatus;
  nativeReady: boolean;
  error: string | null;
};

async function codespaceApiAuth(): Promise<GitHubApiAuth> {
  const [status, nativeStatus] = await Promise.all([
    githubCliStatus(),
    gitHubNativeAuthStatus()
  ]);
  const nativeReady =
    nativeStatus.configured &&
    nativeStatus.authenticated &&
    hasNativeCodespaceScope(nativeStatus);
  if (nativeReady) {
    return { status, nativeReady: true, error: null };
  }
  if (!status.installed || !status.authenticated) {
    return { status, nativeReady: false, error: status.error };
  }
  if (!hasCodespaceScope(status)) {
    return {
      status,
      nativeReady: false,
      error: "GitHub CLI needs the codespace scope. Run gh auth refresh -h github.com -s codespace."
    };
  }
  return { status, nativeReady: false, error: null };
}

async function generalGitHubApiAuth(): Promise<GitHubApiAuth> {
  const [status, nativeStatus] = await Promise.all([
    githubCliStatus(),
    gitHubNativeAuthStatus()
  ]);
  const nativeReady = nativeStatus.configured && nativeStatus.authenticated;
  if (nativeReady || (status.installed && status.authenticated)) {
    return { status, nativeReady, error: null };
  }
  return { status, nativeReady: false, error: status.error };
}

type GitHubApiRequestOptions = {
  method?: "GET" | "POST" | "DELETE";
  fields?: Record<string, string>;
  silent?: boolean;
};

async function runGitHubApi(
  apiPath: string,
  options: GitHubApiRequestOptions,
  timeout: number
): Promise<CommandResult> {
  const token = await gitHubNativeAccessToken(options.method === "GET" ? undefined : "codespace");
  const ghPath = resolveCommandPathSync("gh");
  if (token) {
    const nativeResult = await fetchGitHubApiCommand(apiPath, options, token, timeout);
    if (nativeResult.exitCode === 0 || !ghPath) {
      return nativeResult;
    }
  }

  if (!ghPath) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Install GitHub CLI, then sign in to GitHub."
    };
  }

  return runCommand(ghPath, gitHubApiArgs(apiPath, options), timeout);
}

function runGitHubCliRepoList(timeout: number): Promise<CommandResult> {
  const ghPath = resolveCommandPathSync("gh");
  if (!ghPath) {
    return Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: "Install GitHub CLI, then sign in to GitHub."
    });
  }

  return runCommand(
    ghPath,
    ["repo", "list", "--limit", "100", "--json", "nameWithOwner,isPrivate,defaultBranchRef"],
    timeout
  );
}

function gitHubApiArgs(apiPath: string, options: GitHubApiRequestOptions): string[] {
  const args = ["api"];
  const method = options.method || "GET";
  if (method !== "GET") {
    args.push("--method", method);
  }
  args.push(apiPath);
  for (const [key, value] of Object.entries(options.fields || {})) {
    args.push("--field", `${key}=${value}`);
  }
  if (options.silent) {
    args.push("--silent");
  }
  return args;
}

async function fetchGitHubApiCommand(
  apiPath: string,
  options: GitHubApiRequestOptions,
  token: string,
  timeout: number
): Promise<CommandResult> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${GITHUB_API_URL}${apiPath}`, {
      method: options.method || "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...(options.fields ? { "Content-Type": "application/json" } : {})
      },
      body: options.fields ? JSON.stringify(options.fields) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    return {
      exitCode: response.ok ? 0 : response.status,
      stdout: response.ok && !options.silent ? text : "",
      stderr: response.ok ? "" : cleanGitHubApiError(text) || `GitHub API failed with status ${response.status}.`
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : "GitHub API request failed."
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function cleanGitHubApiError(text: string): string | null {
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed)) {
      return stringValue(parsed.message);
    }
  } catch {
    // Fall through to raw text below.
  }
  return text.trim() || null;
}

function cleanCommandError(result: CommandResult): string | null {
  const message = (result.stderr || result.stdout).trim();
  return message || null;
}

function runCommand(command: string, args: string[], timeout: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        const exitCode =
          typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({
          exitCode,
          stdout: stdout.toString(),
          stderr: stderr.toString()
        });
      }
    );
  });
}

module.exports = {
  createGitHubCodespace,
  disconnectGitHubCli,
  gitHubCodespaceDefaults,
  githubCliStatus,
  listGitHubBranches,
  listGitHubCodespaces,
  listGitHubCodespaceMachines,
  listGitHubRepositories,
  manageGitHubCodespace,
  normalizeRepository,
  refreshGitHubCliCodespaceScope,
  signInGitHubCli,
  validateCodespaceName
};
