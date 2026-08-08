import type { SlackActivityStep } from "./activity-steps.ts";
import { createSlackDeltaProjector } from "./stream-projector.ts";
import { sleep } from "../util/async.ts";
import { createHash } from "node:crypto";

interface Streamer {
  readonly ts?: string;
  append(args: { markdown_text?: string; chunks?: Array<Record<string, unknown>> }): Promise<unknown>;
  stop(args?: {
    markdown_text?: string;
    chunks?: Array<Record<string, unknown>>;
    blocks?: Array<Record<string, unknown>>;
  }): Promise<unknown>;
}

export interface StreamPresenter {
  pushDelta(delta: string): void;
  pushActivity(steps: SlackActivityStep[]): void;
  finish(
    text: string,
    blocks?: Array<Record<string, unknown>>,
    terminalStreamText?: string | null,
    recoveryBlocks?: Array<Record<string, unknown>>,
  ): Promise<"none" | "delivered" | "recoverable" | "orphaned">;
  discard(): Promise<void>;
  failed(): boolean;
}

const MARKDOWN_TEXT_LIMIT = 12_000;
const LIVE_TEXT_LIMIT = 40_000;

function splitMarkdownText(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (chunk.length + char.length > MARKDOWN_TEXT_LIMIT) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

const taskStatus = (state: SlackActivityStep["state"]): "pending" | "in_progress" | "complete" | "error" => {
  if (state === "pending") return "pending";
  if (state === "in_progress" || state === "waiting_approval") return "in_progress";
  if (state === "failed") return "error";
  return "complete";
};

const taskId = (step: SlackActivityStep): string => {
  if (step.id && step.id.length <= 255) return step.id;
  return `task:${createHash("sha256").update(`${step.id}\0${step.title}`).digest("hex")}`;
};

const taskTitle = (title: string): string => Array.from(title).slice(0, 256).join("");

export function createStreamPresenter(deps: {
  create(): Streamer;
  checkpoint(ts: string): Promise<void>;
  finalize(ts: string, text: string, blocks?: Array<Record<string, unknown>>): Promise<void>;
  remove(ts: string): Promise<void>;
  onDelivered?(ts: string, text: string): Promise<void> | void;
  onError?(error: unknown): void;
}): StreamPresenter {
  const projector = createSlackDeltaProjector();
  let streamer: Streamer | undefined;
  let chain = Promise.resolve();
  let failure: unknown;
  let checkpointed = false;
  let opened = false;
  let liveTextLength = 0;
  let liveTextTruncated = false;
  let liveText = "";
  const accepted = (text: string): string => {
    liveText += text;
    return text;
  };
  const boundLiveText = (text: string): string => {
    if (!text || liveTextTruncated) return "";
    const remaining = LIVE_TEXT_LIMIT - liveTextLength;
    if (remaining <= 0) {
      liveTextTruncated = true;
      return "";
    }
    if (text.length <= remaining) {
      liveTextLength += text.length;
      return accepted(text);
    }
    let bounded = "";
    for (const char of text) {
      if (bounded.length + char.length > Math.max(0, remaining - 1)) break;
      bounded += char;
    }
    liveTextLength += bounded.length + 1;
    liveTextTruncated = true;
    return accepted(`${bounded}…`);
  };
  const enqueue = (operation: () => Promise<void>): void => {
    chain = chain.then(operation).catch((error) => {
      failure ??= error;
      deps.onError?.(error);
    });
  };
  const ensure = (): Streamer => (streamer ??= deps.create());
  const checkpoint = async (): Promise<void> => {
    if (checkpointed || !streamer?.ts) return;
    await deps.checkpoint(streamer.ts);
    checkpointed = true;
  };
  const ensureCheckpoint = async (): Promise<boolean> => {
    if (checkpointed) return true;
    for (const delay of [0, 250, 1_000]) {
      if (delay) await sleep(delay);
      try {
        await checkpoint();
        if (checkpointed) return true;
      } catch (error) {
        failure ??= error;
        deps.onError?.(error);
      }
    }
    return false;
  };
  const append = (text: string, chunks?: Array<Record<string, unknown>>): void => {
    if (!text && !chunks?.length) return;
    opened = true;
    const textChunks = text ? splitMarkdownText(text) : [""];
    for (const [index, markdownText] of textChunks.entries())
      enqueue(async () => {
        const active = ensure();
        const forceFirstFlush = !active.ts;
        const taskChunks = index === textChunks.length - 1 ? chunks : undefined;
        let flushChunks: Array<Record<string, unknown>> | undefined;
        if (taskChunks?.length) flushChunks = taskChunks;
        else if (forceFirstFlush) flushChunks = [];
        await active.append({
          ...(markdownText ? { markdown_text: markdownText } : {}),
          ...(flushChunks ? { chunks: flushChunks } : {}),
        });
        await checkpoint();
      });
  };
  return {
    pushDelta(delta) {
      append(boundLiveText(projector.push(delta)));
    },
    pushActivity(steps) {
      append(
        "",
        steps.map((step) => ({
          type: "task_update",
          id: taskId(step),
          title: taskTitle(step.title),
          status: taskStatus(step.state),
        })),
      );
    },
    async finish(text, blocks, terminalStreamText = text, recoveryBlocks) {
      append(boundLiveText(projector.finish()));
      await chain;
      const terminalText = terminalStreamText === null ? liveText || text : terminalStreamText;
      if (!terminalText.startsWith(liveText)) {
        if (streamer?.ts) {
          await streamer.stop().catch((error) => deps.onError?.(error));
          try {
            await deps.remove(streamer.ts);
          } catch (error) {
            deps.onError?.(error);
            return "orphaned";
          }
        }
        return "none";
      }
      const terminalRemainder = boundLiveText(terminalText.slice(liveText.length));
      if (!opened && !terminalRemainder) return "none";
      opened = true;
      const active = ensure();
      if (failure && !active.ts) return "none";
      if (active.ts && !(await ensureCheckpoint())) {
        try {
          await active.stop({
            ...(terminalRemainder ? { markdown_text: terminalRemainder } : {}),
            ...(blocks ? { blocks } : {}),
          });
          await deps.remove(active.ts);
          return "none";
        } catch (error) {
          deps.onError?.(error);
          return "orphaned";
        }
      }
      try {
        await active.stop({ ...(terminalRemainder ? { markdown_text: terminalRemainder } : {}), ...(blocks ? { blocks } : {}) });
        if (!(await ensureCheckpoint()) && active.ts) return "orphaned";
        if (!active.ts) return "none";
      } catch (error) {
        failure ??= error;
        deps.onError?.(error);
        if (!active.ts) return "none";
        try {
          await deps.finalize(active.ts, text, recoveryBlocks);
          return "delivered";
        } catch (finalizeError) {
          deps.onError?.(finalizeError);
          return "recoverable";
        }
      }
      const ts = active.ts;
      if (!ts) return "none";
      try {
        await deps.onDelivered?.(ts, text);
        return "delivered";
      } catch (error) {
        deps.onError?.(error);
        return "recoverable";
      }
    },
    async discard() {
      await chain;
      if (!streamer?.ts) return;
      await streamer.stop().catch((error) => deps.onError?.(error));
      await deps.remove(streamer.ts).catch((error) => deps.onError?.(error));
    },
    failed: () => failure !== undefined,
  };
}
