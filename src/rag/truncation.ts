/**
 * When the generator stops at its token limit (finish_reason "length"), the
 * answer ends mid-word ("कार्य की विशिष"). Hindi uses several times more tokens
 * per word than English, so Hindi answers hit the limit first. Instead of
 * showing a broken sentence, cut back to the last complete sentence or bullet
 * and drop a dangling lead-in line ("… निम्नलिखित शर्तें दी गई हैं:") that has
 * nothing after it. The UI then marks the answer as shortened.
 */

const TERMINATORS = new Set(["।", "॥", ".", "?", "!"]);

/** Index just after the last sentence end in `line`, ignoring dots inside [S1 p.2]. */
function lastSentenceEnd(line: string): number {
  let depth = 0;
  let end = -1;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === "[") depth++;
    else if (character === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && TERMINATORS.has(character)) {
      // "उ0प्र0." or "Rs." mid-number is rare in answers; digits after a dot
      // (e.g. "2.5") are not a sentence end.
      if (character === "." && /\d/.test(line[index + 1] ?? "")) continue;
      end = index + 1;
    }
  }
  if (end < 0) return -1;
  // Keep a citation that directly follows the sentence end: "… है। [S1 p.1]"
  const rest = line.slice(end);
  const citation = /^\s*(\[[^\]]+\]\s*)+[।.]?/.exec(rest);
  return citation ? end + citation[0].length : end;
}

const complete = (line: string) => /([।॥.?!)\]]|\]\s*[।.])\s*$/.test(line.trim());

export function trimIncompleteAnswer(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");

  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (!last.trim()) {
      lines.pop();
      continue;
    }
    if (complete(last)) break;
    const cut = lastSentenceEnd(last);
    if (cut > 0 && last.slice(0, cut).replace(/^[\s\-*•\d.)]+/, "").trim().length > 0) {
      lines[lines.length - 1] = last.slice(0, cut).trimEnd();
      break;
    }
    lines.pop();
  }

  // A lead-in ending with ":" and no items after it says nothing on its own.
  while (lines.length > 1 && /[:：]\s*$/.test(lines[lines.length - 1].trim())) {
    lines.pop();
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  }

  return lines.join("\n").trim();
}
