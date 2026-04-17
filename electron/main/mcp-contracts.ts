import { z } from "zod";

import type {
  ClaudeSettingsContext,
  DirectoryReadResult,
  EphemeralToolId,
  MarketplaceInspectResponse,
  MarketplaceInstallResponse,
  MarketplaceInstallScope,
  MarketplaceReviewState,
  MarketplaceSkillDetails,
  ReadFileResult,
  RepoAppLaunchConfig,
  SessionSearchResponse,
  SessionSearchSource,
  SessionTagColor,
  TrackedPortStatus,
  WikiContext,
  WikiFileContents
} from "../shared-types";

const SESSION_TAG_COLOR_VALUES = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "gray"
] as const satisfies readonly SessionTagColor[];

const SESSION_SEARCH_SOURCE_VALUES = [
  "claude",
  "codex"
] as const satisfies readonly SessionSearchSource[];

const MARKETPLACE_REVIEW_STATE_VALUES = [
  "reviewed",
  "unreviewed"
] as const satisfies readonly MarketplaceReviewState[];

const MARKETPLACE_INSTALL_SCOPE_VALUES = [
  "user",
  "project"
] as const satisfies readonly MarketplaceInstallScope[];

const EPHEMERAL_TOOL_ID_VALUES = [
  "lazygit",
  "tokscale"
] as const satisfies readonly EphemeralToolId[];

const sessionTagColorSchema = z.enum(SESSION_TAG_COLOR_VALUES);
const sessionSearchSourceSchema = z.enum(SESSION_SEARCH_SOURCE_VALUES);
const marketplaceReviewStateSchema = z.enum(MARKETPLACE_REVIEW_STATE_VALUES);
const marketplaceInstallScopeSchema = z.enum(MARKETPLACE_INSTALL_SCOPE_VALUES);
const ephemeralToolIdSchema = z.enum(EPHEMERAL_TOOL_ID_VALUES);

const marketplaceSkillSourceSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.string().optional(),
  path: z.string(),
  reviewState: marketplaceReviewStateSchema.optional(),
  tags: z.array(z.string()).optional()
}).strict();

const marketplaceInstallSourceSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.string().optional(),
  path: z.string()
}).strict();

const preferencesPatchSchema = z.record(z.string(), z.unknown());

export type MarketplaceSkillSourcePayload = z.output<typeof marketplaceSkillSourceSchema>;

export type MarketplaceSkillDetailsArgs =
  | { source: MarketplaceSkillSourcePayload }
  | MarketplaceSkillSourcePayload;

export type MarketplaceInstallArgs =
  | {
      source: z.output<typeof marketplaceInstallSourceSchema>;
      scope: MarketplaceInstallScope;
      repoPath?: string | null;
    }
  | {
      owner: string;
      repo: string;
      ref?: string;
      path: string;
      scope: MarketplaceInstallScope;
      repoPath?: string | null;
    };

export const MCP_ACTION_ARGS_SCHEMAS = {
  create_session: z.object({
    repoId: z.string(),
    autoLaunch: z.boolean().optional(),
    agentId: z.string().optional(),
    prompt: z.string().optional()
  }).strict(),
  rename_session: z.object({
    sessionId: z.string(),
    title: z.string()
  }).strict(),
  close_session: z.object({
    sessionId: z.string()
  }).strict(),
  reopen_session: z.object({
    sessionId: z.string()
  }).strict(),
  organize_session: z.object({
    sessionId: z.string(),
    pin: z.boolean().optional(),
    isPinned: z.boolean().optional(),
    tagColor: z.union([sessionTagColorSchema, z.null()]).optional(),
    repoId: z.string().optional()
  }).strict(),
  search_sessions: z.object({
    repoId: z.string(),
    query: z.string()
  }).strict(),
  resume_session: z.object({
    repoId: z.string(),
    source: sessionSearchSourceSchema.optional(),
    externalSessionId: z.string()
  }).strict(),
  add_workspace: z.object({
    path: z.string()
  }).strict(),
  rescan_workspace: z.object({
    workspaceId: z.string()
  }).strict(),
  set_build_run_config: z.object({
    repoId: z.string(),
    buildCommand: z.string(),
    runCommand: z.string()
  }).strict(),
  build_and_run_app: z.object({
    repoId: z.string()
  }).strict(),
  list_files: z.object({
    repoId: z.string()
  }).strict(),
  read_file: z.object({
    repoId: z.string(),
    path: z.string()
  }).strict(),
  update_preferences: z.union([
    z.object({
      patch: preferencesPatchSchema
    }).strict(),
    preferencesPatchSchema
  ]),
  get_settings_context: z.object({
    repoId: z.string()
  }).strict(),
  load_settings_file: z.object({
    repoId: z.string(),
    filePath: z.string()
  }).strict(),
  save_settings_file: z.object({
    repoId: z.string(),
    filePath: z.string(),
    content: z.string()
  }).strict(),
  get_wiki: z.object({
    repoId: z.string()
  }).strict(),
  read_wiki_page: z.object({
    repoId: z.string(),
    path: z.string()
  }).strict(),
  toggle_wiki: z.object({
    repoId: z.string(),
    enabled: z.boolean()
  }).strict(),
  get_skill_details: z.union([
    marketplaceSkillSourceSchema,
    z.object({
      source: marketplaceSkillSourceSchema
    }).strict()
  ]),
  inspect_skill_url: z.object({
    url: z.string()
  }).strict(),
  install_skill: z.union([
    z.object({
      source: marketplaceInstallSourceSchema,
      scope: marketplaceInstallScopeSchema,
      repoPath: z.union([z.string(), z.null()]).optional()
    }).strict(),
    z.object({
      owner: z.string(),
      repo: z.string(),
      ref: z.string().optional(),
      path: z.string(),
      scope: marketplaceInstallScopeSchema,
      repoPath: z.union([z.string(), z.null()]).optional()
    }).strict()
  ]),
  get_port_status: z.object({}).strict(),
  launch_ephemeral_tool: z.object({
    toolId: ephemeralToolIdSchema,
    repoId: z.string()
  }).strict(),
  close_ephemeral_tool: z.object({
    toolId: ephemeralToolIdSchema,
    sessionId: z.string()
  }).strict()
} as const;

export type McpActionName = keyof typeof MCP_ACTION_ARGS_SCHEMAS;

export type McpActionArgsMap = {
  [Action in McpActionName]: z.output<(typeof MCP_ACTION_ARGS_SCHEMAS)[Action]>;
};

export type McpActionResultMap = {
  create_session: string | null;
  rename_session: boolean;
  close_session: void;
  reopen_session: void;
  organize_session: boolean;
  search_sessions: SessionSearchResponse;
  resume_session: string | null;
  add_workspace: void;
  rescan_workspace: void;
  set_build_run_config: RepoAppLaunchConfig | null;
  build_and_run_app: string | null;
  list_files: DirectoryReadResult;
  read_file: ReadFileResult;
  update_preferences: void;
  get_settings_context: ClaudeSettingsContext;
  load_settings_file: string;
  save_settings_file: { ok: true };
  get_wiki: WikiContext | null;
  read_wiki_page: WikiFileContents;
  toggle_wiki: WikiContext | null;
  get_skill_details: MarketplaceSkillDetails;
  inspect_skill_url: MarketplaceInspectResponse;
  install_skill: MarketplaceInstallResponse;
  get_port_status: TrackedPortStatus;
  launch_ephemeral_tool: string | null;
  close_ephemeral_tool: void;
};

export type McpActionArgs<Action extends McpActionName> = McpActionArgsMap[Action];
export type McpActionResult<Action extends McpActionName> = McpActionResultMap[Action];

export function parseMcpActionArgs<Action extends McpActionName>(
  action: Action,
  args: unknown
): McpActionArgs<Action> {
  return MCP_ACTION_ARGS_SCHEMAS[action].parse(args) as McpActionArgs<Action>;
}

export function extractPreferencesPatch(
  args: McpActionArgs<"update_preferences">
): Record<string, unknown> {
  return ("patch" in args ? args.patch : args) as Record<string, unknown>;
}

export function normalizeOrganizeSessionArgs(
  args: McpActionArgs<"organize_session">
): {
  sessionId: string;
  isPinned?: boolean;
  tagColor?: SessionTagColor | null;
  repoId?: string;
} {
  return {
    sessionId: args.sessionId,
    isPinned: args.isPinned ?? args.pin,
    tagColor: args.tagColor,
    repoId: args.repoId
  };
}

export function normalizeMarketplaceSkillDetailsArgs(
  args: McpActionArgs<"get_skill_details">
): { source: MarketplaceSkillSourcePayload } {
  return "source" in args ? args : { source: args };
}

export function normalizeMarketplaceInstallArgs(
  args: McpActionArgs<"install_skill">
): {
  source: { owner: string; repo: string; ref?: string; path: string };
  scope: MarketplaceInstallScope;
  repoPath?: string | null;
} {
  if ("source" in args) {
    return args;
  }

  return {
    source: {
      owner: args.owner,
      repo: args.repo,
      ref: args.ref,
      path: args.path
    },
    scope: args.scope,
    repoPath: args.repoPath
  };
}
