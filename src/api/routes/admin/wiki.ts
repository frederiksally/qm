import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";

async function wikiAdmin(ctx: ApiCtx, action: string, resource: string) {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return null;
  audit(ctx.deps, { principalId: actor.id, action, resource, scopeLabel: scope });
  return { actor, scope };
}

function boundedInteger(raw: string | null, fallback: number, maximum: number): number | null {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= maximum ? value : null;
}

export async function searchWiki(ctx: ApiCtx): Promise<void> {
  const query = (ctx.url.searchParams.get("q") ?? "").trim();
  if (!query) return sendJson(ctx.res, 400, { error: "bad_request", message: "q required" });
  const authz = await wikiAdmin(ctx, "wiki.search", query);
  if (!authz) return;
  if (!ctx.deps.brain) return sendJson(ctx.res, 503, { error: "wiki_unavailable" });
  const limit = boundedInteger(ctx.url.searchParams.get("limit"), 20, 50);
  if (limit === null)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "limit must be an integer from 1 to 50" });
  const result = await ctx.deps.brain.query(query, limit, authz.actor.id);
  return result.ok
    ? sendJson(ctx.res, 200, { query, lines: result.lines })
    : sendJson(ctx.res, 502, { error: "wiki_unreachable" });
}

export async function readWikiPage(ctx: ApiCtx): Promise<void> {
  const slug = ctx.params.slug?.trim() ?? "";
  if (slug.length > 200 || !/^[\p{L}\p{N}][\p{L}\p{N}-]*$/u.test(slug))
    return sendJson(ctx.res, 400, { error: "bad_request", message: "invalid slug" });
  const authz = await wikiAdmin(ctx, "wiki.page", slug);
  if (!authz) return;
  if (!ctx.deps.brain) return sendJson(ctx.res, 503, { error: "wiki_unavailable" });
  const result = await ctx.deps.brain.page(slug, authz.actor.id);
  if (!result.ok) return sendJson(ctx.res, 502, { error: "wiki_unreachable" });
  return result.body === null
    ? sendJson(ctx.res, 404, { error: "not_found" })
    : sendJson(ctx.res, 200, { slug, body: result.body });
}

export async function readWikiRecent(ctx: ApiCtx): Promise<void> {
  const days = boundedInteger(ctx.url.searchParams.get("days"), 7, 90);
  if (days === null)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "days must be an integer from 1 to 90" });
  const authz = await wikiAdmin(ctx, "wiki.recent", `${days}d`);
  if (!authz) return;
  if (!ctx.deps.brain) return sendJson(ctx.res, 503, { error: "wiki_unavailable" });
  const result = await ctx.deps.brain.recent(days, authz.actor.id);
  return result.ok
    ? sendJson(ctx.res, 200, { days, body: result.body })
    : sendJson(ctx.res, 502, { error: "wiki_unreachable" });
}
