import * as path from "node:path";

/** True if `filePath` is `dir` or a file/directory inside `dir`. */
export function isPathInsideDir(filePath: string, dir: string): boolean {
  const rel = path.relative(dir, filePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
