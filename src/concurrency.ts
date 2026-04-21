/**
 * Run up to `limit` async tasks at once. Returns when all have settled.
 * Rejects with the first error; remaining tasks complete but errors are ignored.
 */
export async function runPool<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const n = Math.max(1, Math.floor(limit));
  let idx = 0;
  let firstError: unknown = null;
  const workers: Promise<void>[] = [];
  const run = async (): Promise<void> => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        await task(items[i]);
      } catch (e) {
        if (firstError === null) firstError = e;
      }
    }
  };
  for (let i = 0; i < n; i++) workers.push(run());
  await Promise.all(workers);
  if (firstError) throw firstError;
}

/**
 * Group topologically-ordered names into levels where nodes in the same level
 * have no dependency edges between them — safe to run in parallel.
 */
export function groupIntoLevels(
  topoOrder: string[],
  dependsOn: Map<string, Set<string>>,
): string[][] {
  const levelOf = new Map<string, number>();
  for (const name of topoOrder) {
    let level = 0;
    const deps = dependsOn.get(name);
    if (deps) {
      for (const d of deps) {
        const dl = levelOf.get(d);
        if (dl !== undefined && dl + 1 > level) level = dl + 1;
      }
    }
    levelOf.set(name, level);
  }
  const levels: string[][] = [];
  for (const name of topoOrder) {
    const lvl = levelOf.get(name) ?? 0;
    while (levels.length <= lvl) levels.push([]);
    levels[lvl].push(name);
  }
  return levels;
}
