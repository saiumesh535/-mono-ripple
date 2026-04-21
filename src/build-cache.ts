import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import type { HookCommand } from "./cli-options";
import { formatHook } from "./run-shell";

/**
 * Content-hash-based skip cache for `customBuild`.
 *
 * Before each build we hash the package's source files + the command. If the
 * combined hash matches the last recorded hash for this package, we skip
 * the build. Hashes live under `<pkgRoot>/node_modules/.cache/monoripple/`,
 * co-located with the package so they travel with the install.
 */

const CACHE_DIR_NAME = path.join("node_modules", ".cache", "monoripple");

const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/coverage/**",
  "**/.cache/**",
  "**/.git/**",
];

function hashFileContent(file: string): string {
  const h = crypto.createHash("sha256");
  const data = fs.readFileSync(file);
  h.update(data);
  return h.digest("hex");
}

/**
 * Compute a deterministic hash over the package's input files + command.
 * File list is collected by fast-glob and sorted; each file contributes
 * `<relpath>\0<sha256>\n`. Cheap enough (~5–30ms for typical packages) to
 * run before every build attempt.
 */
export function computeInputHash(
  pkgRoot: string,
  command: HookCommand,
  extraExcludes: string[] = [],
): string {
  const files = fg.sync(["**/*"], {
    cwd: pkgRoot,
    absolute: false,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: [...DEFAULT_EXCLUDES, ...extraExcludes],
  });
  files.sort();
  const h = crypto.createHash("sha256");
  h.update(`cmd:${formatHook(command)}\n`);
  for (const rel of files) {
    const abs = path.join(pkgRoot, rel);
    let content: string;
    try {
      content = hashFileContent(abs);
    } catch {
      content = "ENOENT";
    }
    h.update(`${rel}\0${content}\n`);
  }
  return h.digest("hex");
}

function cacheFile(pkgRoot: string, key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_@.-]/g, "_");
  return path.join(pkgRoot, CACHE_DIR_NAME, `${safe}.hash`);
}

export function readLastHash(pkgRoot: string, key: string): string | null {
  const file = cacheFile(pkgRoot, key);
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

export function writeHash(
  pkgRoot: string,
  key: string,
  hash: string,
): void {
  const file = cacheFile(pkgRoot, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${hash}\n`, "utf8");
}

export function clearHash(pkgRoot: string, key: string): void {
  try {
    fs.unlinkSync(cacheFile(pkgRoot, key));
  } catch {
    /* no-op */
  }
}
