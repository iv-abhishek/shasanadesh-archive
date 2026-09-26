import { doeGfrAdapter } from "./doe-gfr.js";
import type { SourceAdapter } from "./types.js";

const adapters = new Map<string, SourceAdapter>([[doeGfrAdapter.id, doeGfrAdapter]]);

export function getSourceAdapter(id: string): SourceAdapter {
  const adapter = adapters.get(id);
  if (!adapter) {
    throw new Error('Unknown source adapter "' + id + '". Available: ' + [...adapters.keys()].join(", "));
  }
  return adapter;
}

export function listSourceAdapters(): SourceAdapter[] {
  return [...adapters.values()];
}
