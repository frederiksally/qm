export interface RunActivityEntry {
  seq: number;
  parentSeq: number | null;
  type: string;
  payload: unknown;
  createdAt: number;
}

export interface RunActivityStore {
  append(runId: string, entry: RunActivityEntry): Promise<void>;
  list(runId: string): Promise<RunActivityEntry[]>;
  read(runId: string, cursor?: string, limit?: number): Promise<RunActivityPage>;
  close?(): Promise<void>;
}

export interface RunActivityPage {
  entries: RunActivityEntry[];
  cursor?: string;
  gap: boolean;
}

export const RUN_ACTIVITY_TTL_MS = 60 * 60_000;
const MAX_PER_RUN = 2_000;
const PRUNE_INTERVAL_MS = 60_000;

export function createMemoryRunActivityStore(now: () => number = Date.now): RunActivityStore {
  const runs = new Map<string, Array<{ cursor: number; entry: RunActivityEntry }>>();
  let nextCursor = 1;
  let nextPruneAt = Number.NEGATIVE_INFINITY;
  return {
    async append(runId, entry) {
      const t = now();
      if (t >= nextPruneAt) {
        nextPruneAt = t + PRUNE_INTERVAL_MS;
        const cutoff = t - RUN_ACTIVITY_TTL_MS;
        for (const [id, list] of runs) {
          const kept = list.filter((e) => e.entry.createdAt >= cutoff);
          if (kept.length) runs.set(id, kept);
          else runs.delete(id);
        }
      }
      const list = runs.get(runId) ?? [];
      list.push({ cursor: nextCursor++, entry });
      if (list.length > MAX_PER_RUN) list.splice(0, list.length - MAX_PER_RUN);
      runs.set(runId, list);
    },
    async list(runId) {
      return (runs.get(runId) ?? []).map(({ entry }) => entry);
    },
    async read(runId, rawCursor, rawLimit = 200) {
      const list = runs.get(runId) ?? [];
      const cursor = rawCursor === undefined ? undefined : Number(rawCursor);
      const limit = Math.max(1, Math.min(MAX_PER_RUN, Math.floor(rawLimit)));
      const gap = cursor !== undefined && list.length > 0 && cursor < list[0]!.cursor - 1;
      const start = gap || cursor === undefined ? 0 : list.findIndex((item) => item.cursor > cursor);
      const selected = start < 0 ? [] : list.slice(start, start + limit);
      const next = selected.at(-1)?.cursor ?? cursor;
      return {
        entries: selected.map(({ entry }) => entry),
        ...(next !== undefined ? { cursor: String(next) } : {}),
        gap,
      };
    },
  };
}
