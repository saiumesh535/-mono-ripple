/** Default `packages[…].customBuild` when the entry is `{}` or `customBuild` is omitted. */
export const DEFAULT_PACKAGE_CUSTOM_BUILD = "pnpm run build";

/**
 * A hook command is either:
 * - string: run via the shell (`sh -c "<cmd>"`). Supports pipes, globs, env expansion.
 * - string[]: run via direct spawn (no shell). Safer — no injection, no parsing surprises.
 */
export type HookCommand = string | string[];

export type DepPackageConfig = {
  /**
   * Runs when **this** workspace package’s files change (before `--before` and restart).
   * Runs in **that package’s directory** by default (`customBuildCwd` defaults to `package`).
   *
   * If this package is listed but `customBuild` is omitted (e.g. `{}`),
   * the CLI defaults to {@link DEFAULT_PACKAGE_CUSTOM_BUILD}.
   */
  customBuild?: HookCommand;
  /**
   * Working directory for `customBuild`. Default **`package`**.
   * Use **`workspace-root`** when the command must run from the monorepo root.
   */
  customBuildCwd?: "package" | "workspace-root";
};

/** Per-package hook: explicit `customBuild`, or default when the entry exists but is empty. */
export function effectivePackageCustomBuild(
  pkg: DepPackageConfig | undefined,
): HookCommand | undefined {
  if (pkg === undefined) {
    return undefined;
  }
  const c = pkg.customBuild;
  if (c === undefined) {
    return DEFAULT_PACKAGE_CUSTOM_BUILD;
  }
  if (typeof c === "string") {
    return c.trim() === "" ? undefined : c;
  }
  return c.length === 0 ? undefined : c;
}

/** `cwd` for `runShellCommand(customBuild, …)`. */
export function packageCustomBuildCwd(
  pkg: DepPackageConfig | undefined,
  depPackageRoot: string,
  workspaceRoot: string,
): string {
  if (pkg?.customBuildCwd === "workspace-root") {
    return workspaceRoot;
  }
  return depPackageRoot;
}

export type ParsedCli = {
  appDir: string;
  command: string[];
  /** When true, spawn the dev command with `shell: true` (string commands). */
  commandShell: boolean;
  debounceMs: number;
  verbose: boolean;
  before: HookCommand | undefined;
  beforeDepsOnly: boolean;
  configPath: string | null;
  packageOverrides: Record<string, DepPackageConfig> | undefined;
  interactive: boolean;
  json: boolean;
  statusLine: boolean;
  allowHooks: boolean;
  strictHooks: boolean;
  killTimeoutMs: number;
  dryRun: boolean;
  explain: boolean;
  noCache: boolean;
  cooldownMs: number;
  buildConcurrency: number;
  allowCjsConfig: boolean;
  allowHooksJs: boolean;
  useGitignore: boolean;
};
