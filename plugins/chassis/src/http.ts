import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export class PayloadTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "PayloadTooLargeError";
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage, maxBytes = Infinity): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new PayloadTooLargeError();
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function cookie(req: IncomingMessage, name: string): string | null {
  const m = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1] ?? "") || null : null;
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

export function serveEmojiFavicon(res: ServerResponse, emoji: string, cacheControl: string): void {
  res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": cacheControl });
  res.end(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90" text-anchor="middle" x="50">${emoji}</text></svg>`,
  );
}

const BRAND_IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

export function serveBrandImage(res: ServerResponse, file: string | undefined, cacheControl: string): void {
  const type = file ? BRAND_IMAGE_TYPES[extname(file).toLowerCase()] : undefined;
  if (!file || !type) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  let data: Buffer;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("bad brand image");
    data = readFileSync(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": type, "cache-control": cacheControl, "content-length": data.length });
  res.end(data);
}
