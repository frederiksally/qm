import type { AuditLog } from "../audit/audit-log.ts";
import { BrainNotFoundError, createBrainMcp, parseWhoami, resultText, type BrainFetch } from "./brain-mcp.ts";
import { errMessage } from "../util/errors.ts";

const DEFAULT_QUERY_LIMIT = 20;

type BrainAuth = "oauth-client-credentials" | "bearer";

export interface BrainQueryOptions {
  mcpUrl: string;
  auth?: BrainAuth;
  clientId?: string;
  clientSecret?: string;
  bearerToken?: string;
  queryTool?: string;
  pageTool?: string;
  recentTool?: string;
  defaultLimit?: number;
  audit?: AuditLog;
  fetchImpl?: BrainFetch;
  now?: () => number;
  requestTimeoutMs?: number;
}

export type BrainRead = { ok: true; body: string | null } | { ok: false };
export type BrainSearch = { ok: true; lines: string[] } | { ok: false };

const FAILED = { ok: false } as const;

export interface BrainQueryService {
  query(q: string, limit?: number, principalId?: string): Promise<BrainSearch>;
  page(slug: string, principalId?: string): Promise<BrainRead>;
  recent(days?: number, principalId?: string): Promise<BrainRead>;
}

export function hasBrainQueryCredentials(
  opts: Pick<BrainQueryOptions, "auth" | "bearerToken" | "clientId" | "clientSecret">,
): boolean {
  const auth = opts.auth ?? (opts.bearerToken ? "bearer" : "oauth-client-credentials");
  return auth === "bearer" ? Boolean(opts.bearerToken) : Boolean(opts.clientId && opts.clientSecret);
}

export function createBrainQueryService(opts: BrainQueryOptions): BrainQueryService {
  const now = opts.now ?? (() => Date.now());
  const mcp = createBrainMcp({
    mcpUrl: opts.mcpUrl,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    now,
  });
  const auth: BrainAuth = opts.auth ?? (opts.bearerToken ? "bearer" : "oauth-client-credentials");
  const queryTool = opts.queryTool ?? "query";
  const pageTool = opts.pageTool;
  const recentTool = opts.recentTool;
  const defaultLimit = opts.defaultLimit ?? DEFAULT_QUERY_LIMIT;
  let probed = false;

  function audit(action: string, status: string, principalId?: string): void {
    opts.audit?.record({
      at: now(),
      principalId: principalId || "system",
      action: `brain.${action}`,
      resource: mcp.host,
      scopeLabel: "team-brain",
      status,
    });
  }

  async function resolveToken(): Promise<string> {
    if (auth === "bearer") {
      if (!opts.bearerToken) throw new Error("brain bearer auth configured without a token");
      return opts.bearerToken;
    }
    return mcp.mintToken(opts.clientId ?? "", opts.clientSecret ?? "");
  }

  async function logIdentityOnce(token: string, principalId?: string): Promise<void> {
    if (probed || auth === "bearer") return;
    probed = true;
    try {
      const who = parseWhoami(await mcp.call(token, "whoami", {}));
      if (who)
        audit("whoami", `source=${who.sourceId} federated_read=${who.federatedRead.join(",") || "-"}`, principalId);
    } catch {
      probed = false;
    }
  }

  return {
    async query(q, limit = defaultLimit, principalId) {
      if (!q.trim()) return FAILED;
      let token: string;
      try {
        token = await resolveToken();
      } catch (e) {
        audit(queryTool, `token_error: ${errMessage(e)}`, principalId);
        return FAILED;
      }
      await logIdentityOnce(token, principalId);
      try {
        const result = await mcp.call(token, queryTool, { query: q, limit });
        const lines = resultText(result)
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, limit);
        audit(queryTool, lines.length ? "ok" : "empty", principalId);
        return { ok: true, lines };
      } catch (e) {
        audit(queryTool, `error: ${errMessage(e)}`, principalId);
        return FAILED;
      }
    },

    async page(slug, principalId) {
      if (!pageTool || !slug.trim()) return FAILED;
      let token: string;
      try {
        token = await resolveToken();
      } catch (e) {
        audit(pageTool, `token_error: ${errMessage(e)}`, principalId);
        return FAILED;
      }
      await logIdentityOnce(token, principalId);
      try {
        const body = resultText(await mcp.call(token, pageTool, { slug })).trim();
        audit(pageTool, body ? "ok" : "empty", principalId);
        return { ok: true, body: body || null };
      } catch (e) {
        if (e instanceof BrainNotFoundError) {
          audit(pageTool, "empty", principalId);
          return { ok: true, body: null };
        }
        audit(pageTool, `error: ${errMessage(e)}`, principalId);
        return FAILED;
      }
    },

    async recent(days, principalId) {
      if (!recentTool) return FAILED;
      let token: string;
      try {
        token = await resolveToken();
      } catch (e) {
        audit(recentTool, `token_error: ${errMessage(e)}`, principalId);
        return FAILED;
      }
      await logIdentityOnce(token, principalId);
      try {
        const args = days === undefined ? {} : { days };
        const body = resultText(await mcp.call(token, recentTool, args)).trim();
        audit(recentTool, body ? "ok" : "empty", principalId);
        return { ok: true, body: body || null };
      } catch (e) {
        audit(recentTool, `error: ${errMessage(e)}`, principalId);
        return FAILED;
      }
    },
  };
}
