/**
 * Streams the model's first draft to the browser as an unchecked preview
 * (SSE "draft" events) while it is written. The validated answer replaces it.
 *
 * Held back: a leading <think> reasoning block (some hosted Qwen3 builds), and
 * anything that could still be the NO_ANSWER_IN_EVIDENCE reply. Sent in
 * batches of at least `minBatch` characters to keep the event count low.
 */

import { NO_ANSWER_TOKEN } from "./relevance.js";

export function stripThinking(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, "");
}

export function createDraftStreamer(send: (text: string) => void, minBatch = 24) {
  let buffer = "";
  let sent = 0;

  const visible = (): string | null => {
    const raw = buffer.trimStart();
    if (raw.startsWith("<think>") && !raw.includes("</think>")) return null;
    if (raw.length < 7 && "<think>".startsWith(raw)) return null;
    const text = stripThinking(buffer).trimStart();
    if (text.startsWith(NO_ANSWER_TOKEN)) return null;
    if (text.length <= NO_ANSWER_TOKEN.length && NO_ANSWER_TOKEN.startsWith(text)) return null;
    return text;
  };

  const flush = (force: boolean) => {
    const text = visible();
    if (text === null) return;
    if (force ? text.length > sent : text.length - sent >= minBatch) {
      send(text.slice(sent));
      sent = text.length;
    }
  };

  return {
    onDelta(delta: string) {
      buffer += delta;
      flush(false);
    },
    /** Send whatever is left once generation ends. */
    finish() {
      flush(true);
    },
  };
}
