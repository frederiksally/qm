const TOKEN_SKEW_MS = 60_000;

const MCP_ACCEPT = "application/json, text/event-stream";

interface BrainResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}

export type BrainFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<BrainResponse>;

const realFetch: BrainFetch = (url, init) => fetch(url, init);

function baseUrl(mcpUrl: string): string {
  return mcpUrl.replace(/\/+$/g, "").replace(/\/mcp$/g, "");
}

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface McpEnvelope {
  result?: McpResult;
  error?: { message?: string };
  id?: unknown;
}

function parseSseEnvelopes(body: string): McpEnvelope[] {
  const out: McpEnvelope[] = [];
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    const parsed = safeJson(data) as McpEnvelope | null;
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseMcpEnvelope(text: string, contentType: string | null | undefined, id?: unknown): McpEnvelope | null {
  const isSse = !!contentType && contentType.toLowerCase().includes("text/event-stream");
  if (isSse) {
    const envelopes = parseSseEnvelopes(text);
    const carries = (e: McpEnvelope): boolean => e.result !== undefined || e.error !== undefined;
    return (
      (id !== undefined ? envelopes.find((e) => e.id === id && carries(e)) : undefined) ??
      envelopes.find(carries) ??
      null
    );
  }
  return safeJson(text) as McpEnvelope | null;
}

export interface McpResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export function resultText(result: McpResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((c) => c?.type === "text")
    .map((c) => String(c.text ?? ""))
    .join("\n")
    .trim();
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export interface BrainMcp {
  readonly base: string;
  readonly host: string;
  mintToken(clientId: string, clientSecret: string): Promise<string>;
  evictToken(clientId: string): void;
  call(accessToken: string, name: string, args: Record<string, unknown>): Promise<McpResult>;
}

export function createBrainMcp(opts: { mcpUrl: string; fetchImpl?: BrainFetch; now?: () => number }): BrainMcp {
  const fetchImpl = opts.fetchImpl ?? realFetch;
  const now = opts.now ?? (() => Date.now());
  const base = baseUrl(opts.mcpUrl);
  const host = hostOf(base);
  const tokenCache = new Map<string, CachedToken>();
  let rpcId = 0;

  return {
    base,
    host,
    async mintToken(clientId, clientSecret) {
      const cached = tokenCache.get(clientId);
      if (cached && now() < cached.expiresAt - TOKEN_SKEW_MS) return cached.accessToken;
      const res = await fetchImpl(`${base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });
      if (!res.ok) throw new Error(`brain token mint failed (HTTP ${res.status})`);
      const body = (safeJson(await res.text()) ?? {}) as { access_token?: unknown; expires_in?: unknown };
      const accessToken = typeof body.access_token === "string" ? body.access_token : "";
      if (!accessToken) throw new Error("brain token mint returned no access_token");
      const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 0;
      tokenCache.set(clientId, { accessToken, expiresAt: expiresIn > 0 ? now() + expiresIn * 1000 : Infinity });
      return accessToken;
    },
    evictToken(clientId) {
      tokenCache.delete(clientId);
    },
    async call(accessToken, name, args) {
      const id = ++rpcId;
      const res = await fetchImpl(`${base}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: MCP_ACCEPT,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
      });
      if (!res.ok) throw new Error(`brain ${name} failed (HTTP ${res.status})`);
      const parsed = parseMcpEnvelope(await res.text(), res.headers?.get("content-type"), id);
      if (!parsed) throw new Error(`brain ${name} returned non-JSON`);
      if (parsed.error) throw new Error(`brain ${name} error: ${parsed.error.message ?? "unknown"}`);
      const result = parsed.result ?? {};
      if (result.isError) throw new Error(`brain ${name} tool error: ${resultText(result) || "(no detail)"}`);
      return result;
    },
  };
}

export interface BrainWhoami {
  sourceId: string;
  federatedRead: string[];
}

export function parseWhoami(result: McpResult): BrainWhoami | null {
  const raw = (result.structuredContent ?? safeJson(resultText(result))) as {
    source_id?: unknown;
    federated_read?: unknown;
  } | null;
  if (!raw || typeof raw.source_id !== "string") return null;
  const fed = Array.isArray(raw.federated_read)
    ? raw.federated_read.filter((s): s is string => typeof s === "string")
    : [];
  return { sourceId: raw.source_id, federatedRead: fed };
}
