import { parseScopeId, type ScopeId } from "../types.ts";
import type { MemoryService } from "./memory-service.ts";
import type { BrainClient, BrainClientStore } from "./brain-client-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { RECALL_MAX_CHARS, capTail } from "./notebook.ts";
import { createBrainMcp, parseWhoami, resultText, type BrainFetch } from "./brain-mcp.ts";

export type { BrainFetch } from "./brain-mcp.ts";

const DEFAULT_VERIFY_TTL_MS = 10 * 60_000;

export interface BrainMemoryOptions {
  mcpUrl: string;
  clients: BrainClientStore;
  sharedSource?: string;
  fallback?: MemoryService;
  audit?: AuditLog;
  queryTool?: string;
  recallMaxChars?: number;
  fetchImpl?: BrainFetch;
  now?: () => number;
  verifyTtlMs?: number;
}

export function sourceForScope(scopeId: ScopeId): string {
  const s = scopeId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return s || "default";
}

export function createBrainMemoryService(opts: BrainMemoryOptions): MemoryService {
  const now = opts.now ?? (() => Date.now());
  const mcp = createBrainMcp({
    mcpUrl: opts.mcpUrl,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    now,
  });
  const host = mcp.host;
  const sharedSource = opts.sharedSource ?? "shared";
  const fallback = opts.fallback;
  const queryTool = opts.queryTool ?? "search";
  const recallMax = opts.recallMaxChars ?? RECALL_MAX_CHARS;

  const scopeClientId = new Map<ScopeId, string>();
  const verifyTtlMs = opts.verifyTtlMs ?? DEFAULT_VERIFY_TTL_MS;
  const verified = new Map<ScopeId, { ok: boolean; at: number }>();
  function verdict(scopeId: ScopeId): boolean | undefined {
    const v = verified.get(scopeId);
    if (!v || now() - v.at >= verifyTtlMs) return undefined;
    return v.ok;
  }

  opts.clients.onChange?.((scopeId) => {
    verified.delete(scopeId);
    const clientId = scopeClientId.get(scopeId);
    if (clientId !== undefined) {
      mcp.evictToken(clientId);
      scopeClientId.delete(scopeId);
    }
  });

  function audit(scopeId: ScopeId, tool: string, status: string): void {
    opts.audit?.record({
      at: now(),
      principalId: parseScopeId(scopeId).ref || scopeId,
      action: `brain.${tool}`,
      resource: host,
      scopeLabel: scopeId,
      status,
    });
  }

  function cap(text: string): string {
    return capTail(text.trim(), recallMax);
  }

  const mintToken = (client: BrainClient): Promise<string> => mcp.mintToken(client.clientId, client.clientSecret);
  const mcpCall = mcp.call;

  async function resolveSource(scopeId: ScopeId): Promise<{ source: string; token: string } | null> {
    const client = await opts.clients.get(scopeId);
    if (!client) {
      audit(scopeId, "resolve", "no_client");
      return null;
    }
    const expected = sourceForScope(scopeId);
    const allowedReads = new Set([expected, sharedSource]);
    const staticOk =
      client.source === expected &&
      client.federatedRead.includes(expected) &&
      client.federatedRead.every((s) => allowedReads.has(s));
    if (!staticOk) {
      verified.set(scopeId, { ok: false, at: now() });
      audit(scopeId, "resolve", "scope_mismatch");
      return null;
    }
    if (verdict(scopeId) === false) return null;

    let token: string;
    try {
      token = await mintToken(client);
      scopeClientId.set(scopeId, client.clientId);
    } catch {
      audit(scopeId, "resolve", "token_error");
      return null;
    }

    if (verdict(scopeId) !== true) {
      try {
        const who = parseWhoami(await mcpCall(token, "whoami", {}));
        const whoOk =
          !!who &&
          who.sourceId === expected &&
          who.federatedRead.includes(expected) &&
          who.federatedRead.every((s) => allowedReads.has(s));
        if (!whoOk) {
          verified.set(scopeId, { ok: false, at: now() });
          audit(scopeId, "whoami", "scope_mismatch");
          return null;
        }
        verified.set(scopeId, { ok: true, at: now() });
      } catch {
        audit(scopeId, "whoami", "error");
        return null;
      }
    }
    return { source: expected, token };
  }

  return {
    async recall(scopeId) {
      const notebook = fallback ? (await fallback.recall(scopeId)).trim() : "";
      const resolved = await resolveSource(scopeId);
      if (!resolved) return cap(notebook);
      try {
        const facts = resultText(await mcpCall(resolved.token, "recall", { source: resolved.source }));
        audit(scopeId, "recall", "ok");
        return cap([notebook, facts].filter(Boolean).join("\n\n"));
      } catch {
        audit(scopeId, "recall", "error");
        return cap(notebook);
      }
    },

    async capture(scopeId, facts, at, author) {
      const clean = facts.map((f) => f.replace(/\s+/g, " ").trim()).filter(Boolean);
      const notebookAdded = fallback ? await fallback.capture(scopeId, facts, at, author) : 0;
      if (!clean.length) return notebookAdded;

      const resolved = await resolveSource(scopeId);
      let brainAdded = 0;
      if (resolved) {
        try {
          const result = await mcpCall(resolved.token, "extract_facts", {
            text: clean.join("\n"),
            source: resolved.source,
          });
          const structured = result.structuredContent as { count?: unknown } | null;
          brainAdded = typeof structured?.count === "number" ? structured.count : clean.length;
          audit(scopeId, "capture", "ok");
        } catch {
          audit(scopeId, "capture", "error");
        }
      }
      return fallback ? notebookAdded : brainAdded;
    },

    async read(scopeId) {
      return fallback ? fallback.read(scopeId) : "";
    },

    async replace(scopeId, content, author) {
      if (fallback) await fallback.replace(scopeId, content, author);
    },

    async updatedAt(scopeId) {
      return fallback?.updatedAt?.(scopeId);
    },

    ...(fallback?.metadata ? { metadata: () => fallback.metadata!() } : {}),

    async query(scopeId, q, limit = 20) {
      if (!q.trim()) return [];
      const resolved = await resolveSource(scopeId);
      if (!resolved) return [];
      try {
        const result = await mcpCall(resolved.token, queryTool, { query: q, limit });
        const lines = resultText(result)
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        audit(scopeId, queryTool, "ok");
        return lines.slice(0, limit);
      } catch {
        audit(scopeId, queryTool, "error");
        return [];
      }
    },
  };
}
