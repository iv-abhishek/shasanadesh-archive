/**
 * States/UTs and districts with LGD codes (datasets/lgd/lgd-states-districts.json,
 * from the Local Government Directory; npm run ingest:lgd refreshes it).
 *
 * Profiles keep the LGD codes beside the names, so a district officer's
 * profile survives renames (Allahabad → Prayagraj) and lines up with other
 * government systems. resolveState / resolveDistrict accept the LGD name, the
 * Hindi name or a former name, case- and spacing-insensitively.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export interface LgdDistrict {
  code: number;
  name: string;
  local?: string | null;
  hi?: string;
  aliases?: string[];
}

export interface LgdState {
  code: number;
  name: string;
  local?: string | null;
  districts: LgdDistrict[];
}

let cache: LgdState[] | null = null;

export function loadLgdStates(file = path.resolve("datasets/lgd/lgd-states-districts.json")): LgdState[] {
  if (!cache) {
    try {
      cache = (JSON.parse(readFileSync(file, "utf8")) as { states: LgdState[] }).states;
    } catch {
      cache = [];
    }
  }
  return cache;
}

const key = (text: string) =>
  text
    .toLocaleLowerCase("en")
    .replace(/[‌‍]/g, "")
    .replace(/[.,()'-]/g, " ")
    .replace(/\s+/g, "")
    .trim();

export function resolveState(name: string | null | undefined, states = loadLgdStates()): LgdState | undefined {
  if (!name?.trim()) return undefined;
  const wanted = key(name);
  return states.find((state) => [state.name, state.local ?? ""].some((candidate) => candidate && key(candidate) === wanted));
}

export function resolveDistrict(
  state: LgdState | undefined,
  name: string | null | undefined,
): LgdDistrict | undefined {
  if (!state || !name?.trim()) return undefined;
  const wanted = key(name);
  return state.districts.find((district) =>
    [district.name, district.local ?? "", district.hi ?? "", ...(district.aliases ?? [])].some(
      (candidate) => candidate && key(candidate) === wanted,
    ),
  );
}

/**
 * A profile's place as stored: the LGD names and codes when the state (and
 * district) are in LGD, else the text as entered with no code ("Central
 * Government / Other", or a district LGD does not list).
 */
export function profilePlace(
  stateName: string | null | undefined,
  district: string | null | undefined,
): { stateName: string | null; stateCode: number | null; district: string | null; districtCode: number | null } {
  const state = resolveState(stateName);
  const found = resolveDistrict(state, district);
  return {
    stateName: state?.name ?? (stateName?.trim() || null),
    stateCode: state?.code ?? null,
    district: found?.name ?? (district?.trim() || null),
    districtCode: found?.code ?? null,
  };
}
