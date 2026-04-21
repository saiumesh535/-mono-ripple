import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A minimal gitignore-style matcher. Supports:
 *   - Blank lines and `#` comments
 *   - Leading `!` negation
 *   - Leading `/` anchors to the gitignore's directory
 *   - Trailing `/` matches directories only
 *   - `*` (no path sep), `?`, and `**`
 * Not a full gitignore impl, but covers 95% of real-world cases without deps.
 */

type Rule = {
  base: string;
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
};

export type IgnoreMatcher = {
  ignores: (absPath: string, isDir?: boolean) => boolean;
};

function globToRegex(glob: string, anchored: boolean): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (glob[i] === "/") i += 1;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (/[.+^$|(){}\[\]\\]/.test(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  // Trailing `(/.*)?` lets a pattern that matches a directory also match
  // every file inside it — the standard gitignore cascade.
  return new RegExp(anchored ? `^${re}(/.*)?$` : `(^|/)${re}(/.*)?$`);
}

function parseGitignore(file: string): Rule[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const base = path.dirname(path.resolve(file));
  const rules: Rule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }
    let anchored = false;
    if (pattern.startsWith("/")) {
      anchored = true;
      pattern = pattern.slice(1);
    }
    let dirOnly = false;
    if (pattern.endsWith("/")) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    const hasMidSlash = pattern.includes("/");
    const regex = globToRegex(pattern, anchored || hasMidSlash);
    rules.push({ base, negated, dirOnly, regex });
  }
  return rules;
}

/**
 * Load ignore rules from the given .gitignore files. Later files' rules take
 * precedence (same as real git); negation is supported.
 */
export function loadGitignore(files: string[]): IgnoreMatcher {
  const allRules: Rule[] = [];
  for (const f of files) allRules.push(...parseGitignore(f));

  return {
    ignores(absPath: string, isDir = false) {
      let ignored = false;
      const abs = path.resolve(absPath);
      for (const rule of allRules) {
        const rel = path.relative(rule.base, abs);
        if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
        // dirOnly ("foo/") still matches files *inside* foo/ via the trailing
        // (/.*)? in the regex; only skip a non-dir exact-match of the name.
        const relPosix = rel.replace(/\\/g, "/");
        if (rule.dirOnly && !isDir && !relPosix.includes("/")) continue;
        if (rule.regex.test(relPosix)) {
          ignored = !rule.negated;
        }
      }
      return ignored;
    },
  };
}

/** Discover all .gitignore files within `roots` (non-recursive to .git; just each root itself + repoRoot). */
export function findGitignoreFiles(repoRoot: string, roots: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    const abs = path.resolve(p);
    if (!seen.has(abs) && fs.existsSync(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  };
  push(path.join(repoRoot, ".gitignore"));
  for (const r of roots) push(path.join(r, ".gitignore"));
  return out;
}
