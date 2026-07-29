import type { AuditLog } from "../audit/audit-log.ts";
import { createBrainMcp, parseWhoami, resultText, type BrainFetch } from "./brain-mcp.ts";
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
  defaultLimit?: number;
  audit?: AuditLog;
  fetchImpl?: BrainFetch;
  now?: () => number;
}

export interface BrainQueryService {
  query(q: string, limit?: number, principalId?: string): Promise<string[]>;
}

export function createBrainQueryService(opts: BrainQueryOptions): BrainQueryService {
  const now = opts.now ?? (() => Date.now());
  const mcp = createBrainMcp({
    mcpUrl: opts.mcpUrl,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    now,
  });
  const auth: BrainAuth = opts.auth ?? (opts.bearerToken ? "bearer" : "oauth-client-credentials");
  const queryTool = opts.queryTool ?? "query";
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
      if (!q.trim()) return [];
      let token: string;
      try {
        token = await resolveToken();
      } catch (e) {
        audit(queryTool, `token_error: ${errMessage(e)}`, principalId);
        return [];
      }
      await logIdentityOnce(token, principalId);
      try {
        const result = await mcp.call(token, queryTool, { query: q, limit });
        const lines = resultText(result)
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        audit(queryTool, "ok", principalId);
        return lines.slice(0, limit);
      } catch (e) {
        audit(queryTool, `error: ${errMessage(e)}`, principalId);
        return [];
      }
    },
  };
}
