import assert from "node:assert/strict";
import { createDraftStreamer, stripThinking } from "./draft-preview.js";

const run = (chunks: string[]) => {
  const sent: string[] = [];
  const streamer = createDraftStreamer((text) => sent.push(text), 10);
  chunks.forEach((chunk) => streamer.onDelta(chunk));
  streamer.finish();
  return sent.join("");
};

// Normal text arrives in full, batched.
assert.equal(run(["सोलर पंप ", "की स्थापना के ", "उपरान्त रखरखाव [S1 p.7]।"]), "सोलर पंप की स्थापना के उपरान्त रखरखाव [S1 p.7]।");

// The no-answer reply is never previewed, even token by token.
assert.equal(run(["NO_", "ANSWER_", "IN_", "EVIDENCE"]), "");

// A reasoning block is hidden; the answer after it is shown.
assert.equal(run(["<th", "ink>let me think", " about it</think>\n", "The rule applies [S1 p.2]."]), "The rule applies [S1 p.2].");
assert.equal(stripThinking("<think>x</think> Answer"), "Answer");

console.log("draft preview tests passed");
