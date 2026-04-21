import type { DepPackageConfig } from "./cli-options";
import type { DepWatchConfigFile } from "./config";

const PREFIX = "[monoripple]";

export class ConfigValidationError extends Error {
  constructor(
    public readonly file: string,
    public readonly issues: string[],
  ) {
    super(
      `${PREFIX} Invalid config ${file}:\n  - ${issues.join("\n  - ")}`,
    );
    this.name = "ConfigValidationError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function validatePackage(
  at: string,
  raw: unknown,
  issues: string[],
): DepPackageConfig | null {
  if (!isPlainObject(raw)) {
    issues.push(`${at}: expected object, got ${typeof raw}`);
    return null;
  }
  const out: DepPackageConfig = {};
  if ("customBuild" in raw) {
    const c = raw.customBuild;
    if (c !== undefined) {
      if (typeof c === "string") {
        out.customBuild = c;
      } else if (isStringArray(c)) {
        if (c.length === 0) {
          issues.push(`${at}.customBuild: array must have at least one element`);
        } else {
          out.customBuild = c;
        }
      } else {
        issues.push(
          `${at}.customBuild: expected string or string[], got ${typeof c}`,
        );
      }
    }
  }
  if ("customBuildCwd" in raw) {
    const c = raw.customBuildCwd;
    if (c !== undefined) {
      if (c === "package" || c === "workspace-root") {
        out.customBuildCwd = c;
      } else {
        issues.push(
          `${at}.customBuildCwd: expected "package" | "workspace-root", got ${JSON.stringify(c)}`,
        );
      }
    }
  }
  for (const key of Object.keys(raw)) {
    if (key !== "customBuild" && key !== "customBuildCwd") {
      issues.push(`${at}: unknown field "${key}"`);
    }
  }
  return out;
}

/**
 * Parse + validate a raw config object into a typed DepWatchConfigFile.
 * Throws ConfigValidationError with a list of concrete issues.
 */
export function validateConfig(
  file: string,
  raw: unknown,
): DepWatchConfigFile {
  const issues: string[] = [];
  if (!isPlainObject(raw)) {
    throw new ConfigValidationError(file, [
      `root: expected object, got ${Array.isArray(raw) ? "array" : typeof raw}`,
    ]);
  }

  const known = new Set([
    "$schema",
    "app",
    "command",
    "debounce",
    "verbose",
    "before",
    "beforeDepsOnly",
    "interactive",
    "strictHooks",
    "packages",
    "killTimeoutMs",
    "cooldownMs",
    "buildConcurrency",
    "useGitignore",
    "noCache",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      issues.push(`unknown field "${key}"`);
    }
  }

  const out: DepWatchConfigFile = { command: "" as unknown as string };

  if ("app" in raw && raw.app !== undefined) {
    if (typeof raw.app !== "string") {
      issues.push(`"app": expected string, got ${typeof raw.app}`);
    } else {
      out.app = raw.app;
    }
  }

  if (!("command" in raw) || raw.command === undefined || raw.command === null) {
    issues.push(`"command": required (string or string[])`);
  } else if (typeof raw.command === "string") {
    if (raw.command.trim() === "") {
      issues.push(`"command": empty string`);
    } else {
      out.command = raw.command;
    }
  } else if (isStringArray(raw.command)) {
    if (raw.command.length === 0) {
      issues.push(`"command": empty array`);
    } else {
      out.command = raw.command;
    }
  } else {
    issues.push(
      `"command": expected string or string[], got ${typeof raw.command}`,
    );
  }

  if ("debounce" in raw && raw.debounce !== undefined) {
    const n = raw.debounce;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 60_000) {
      issues.push(
        `"debounce": expected integer between 0 and 60000 ms, got ${JSON.stringify(n)}`,
      );
    } else {
      out.debounce = Math.floor(n);
    }
  }

  if ("killTimeoutMs" in raw && raw.killTimeoutMs !== undefined) {
    const n = raw.killTimeoutMs;
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      n < 100 ||
      n > 300_000
    ) {
      issues.push(
        `"killTimeoutMs": expected integer between 100 and 300000, got ${JSON.stringify(n)}`,
      );
    } else {
      out.killTimeoutMs = Math.floor(n);
    }
  }

  if ("cooldownMs" in raw && raw.cooldownMs !== undefined) {
    const n = raw.cooldownMs;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 60_000) {
      issues.push(
        `"cooldownMs": expected integer between 0 and 60000, got ${JSON.stringify(n)}`,
      );
    } else {
      out.cooldownMs = Math.floor(n);
    }
  }

  if ("buildConcurrency" in raw && raw.buildConcurrency !== undefined) {
    const n = raw.buildConcurrency;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 1 || n > 32) {
      issues.push(
        `"buildConcurrency": expected integer between 1 and 32, got ${JSON.stringify(n)}`,
      );
    } else {
      out.buildConcurrency = Math.floor(n);
    }
  }

  for (const flag of ["verbose", "beforeDepsOnly", "interactive", "strictHooks", "useGitignore", "noCache"] as const) {
    if (flag in raw && raw[flag] !== undefined) {
      const v = raw[flag];
      if (typeof v !== "boolean") {
        issues.push(`"${flag}": expected boolean, got ${typeof v}`);
      } else {
        out[flag] = v;
      }
    }
  }

  if ("before" in raw && raw.before !== undefined) {
    const b = raw.before;
    if (typeof b === "string") {
      out.before = b;
    } else if (isStringArray(b)) {
      if (b.length === 0) {
        issues.push(`"before": empty array`);
      } else {
        out.before = b;
      }
    } else {
      issues.push(`"before": expected string or string[], got ${typeof b}`);
    }
  }

  if ("packages" in raw && raw.packages !== undefined) {
    const pkgs = raw.packages;
    if (!isPlainObject(pkgs)) {
      issues.push(`"packages": expected object, got ${typeof pkgs}`);
    } else {
      const mapped: Record<string, DepPackageConfig> = {};
      for (const [name, entry] of Object.entries(pkgs)) {
        if (!name) {
          issues.push(`"packages": empty key`);
          continue;
        }
        const p = validatePackage(`packages["${name}"]`, entry, issues);
        if (p) {
          mapped[name] = p;
        }
      }
      out.packages = mapped;
    }
  }

  if (issues.length > 0) {
    throw new ConfigValidationError(file, issues);
  }
  return out;
}
