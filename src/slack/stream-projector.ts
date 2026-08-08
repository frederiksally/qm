import { stripSlackDirectives } from "./messaging.ts";

export interface SlackDeltaProjector {
  push(delta: string): string;
  finish(): string;
}

export function createSlackDeltaProjector(): SlackDeltaProjector {
  let pending = "";
  const escapeLiveText = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const drain = (final: boolean): string => {
    if (!pending) return "";
    if (final) {
      const out = stripSlackDirectives(pending);
      pending = "";
      return escapeLiveText(out);
    }
    const open = pending.lastIndexOf("[[");
    if (open >= 0 && pending.indexOf("]]", open) < 0) {
      const prefix = pending.slice(0, open);
      pending = pending.slice(open);
      return escapeLiveText(stripSlackDirectives(prefix));
    }
    if (pending.endsWith("[")) {
      const prefix = pending.slice(0, -1);
      pending = "[";
      return escapeLiveText(stripSlackDirectives(prefix));
    }
    const out = stripSlackDirectives(pending);
    pending = "";
    return escapeLiveText(out);
  };
  return {
    push(delta) {
      pending += delta;
      return drain(false);
    },
    finish: () => drain(true),
  };
}

export function projectSlackText(text: string): string {
  const projector = createSlackDeltaProjector();
  return `${projector.push(text)}${projector.finish()}`;
}
