import { swallowAs } from "../util/errors.ts";

export function deriveThreadTitle(text: string, maxLength = 80): string | undefined {
  const plain = text
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/[`*_~>#\]]|\[/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  const clause = plain.split(/(?<=[.!?])\s|\s+[—–-]\s+|[;\n]/, 1)[0]?.trim() ?? "";
  if (!clause) return undefined;
  return clause.length <= maxLength ? clause : `${clause.slice(0, maxLength - 1).trimEnd()}…`;
}

export async function setThreadTitle(client: any, channel: string, threadTs: string, text: string): Promise<void> {
  const title = deriveThreadTitle(text);
  if (!title) return;
  await client.assistant.threads
    .setTitle({ channel_id: channel, thread_ts: threadTs, title })
    .catch(swallowAs("slack: set thread title", undefined));
}
