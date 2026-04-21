import * as path from "node:path";
import { isPathInsideDir } from "./path-utils";
import type { WorkspaceDep } from "./workspace-graph";

/**
 * If `filePath` is inside a workspace dependency (not the app), return that package.
 * Longest-match wins, so nested workspace packages route correctly.
 */
export function findWorkspaceDepForFile(
  filePath: string,
  appRoot: string,
  deps: WorkspaceDep[],
): WorkspaceDep | null {
  const abs = path.normalize(path.resolve(filePath));
  if (isPathInsideDir(abs, appRoot)) {
    return null;
  }
  let best: WorkspaceDep | null = null;
  let bestLen = -1;
  for (const d of deps) {
    const r = path.normalize(d.root);
    if (abs === r || abs.startsWith(r + path.sep)) {
      if (r.length > bestLen) {
        bestLen = r.length;
        best = d;
      }
    }
  }
  return best;
}
