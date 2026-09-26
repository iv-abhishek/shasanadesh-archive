/**
 * Registered official-source adapters. Each adapter's id is also its B2
 * collection (archive/<collection>/…) and its provider value in the database,
 * which keeps sources separated end to end. Keep apps/web/lib/sources.ts in
 * step when adding one (display labels by sourceId prefix).
 */

import { doeGfrAdapter } from "./doe-gfr.js";
import { investUpAdapter } from "./invest-up.js";
import { upgovAdapter } from "./upgov.js";
import { upPoliceAdapter } from "./uppolice.js";
import type { SourceAdapter } from "./types.js";

const adapters = new Map<string, SourceAdapter>(
  [doeGfrAdapter, upgovAdapter, investUpAdapter, upPoliceAdapter].map((adapter) => [adapter.id, adapter]),
);

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
