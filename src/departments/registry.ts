/**
 * Bilingual department registry (ADR-057): Shasanadesh department ID → Hindi
 * name, English name and the aliases people type ("basic education",
 * "PWD", "जेल"). Data: datasets/departments.json.
 *
 * findDepartmentMention() finds the department a question names:
 *   - strong: a multi-word name, or any name followed by "department/dept/विभाग"
 *     ("basic education", "finance department", "कृषि विभाग") — safe to scope
 *     answers to;
 *   - weak: a single word on its own ("finance", "energy") — used only where the
 *     question is clearly about listing orders, since "solar energy" is not a
 *     request for the Energy department.
 * The longest match wins.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export interface DepartmentEntry {
  id: number;
  hi: string;
  en: string;
  enSource: "archive" | "translation";
  aliases: string[];
}

export interface DepartmentMention {
  department: DepartmentEntry;
  strength: "strong" | "weak";
  matched: string;
}

let cache: DepartmentEntry[] | null = null;

export function loadDepartments(file = path.resolve("datasets/departments.json")): DepartmentEntry[] {
  if (!cache) {
    try {
      cache = (JSON.parse(readFileSync(file, "utf8")) as { departments: DepartmentEntry[] }).departments;
    } catch {
      cache = [];
    }
  }
  return cache;
}

export function departmentById(id: number, departments = loadDepartments()): DepartmentEntry | undefined {
  return departments.find((department) => department.id === id);
}

/** Lowercase, no zero-width joiners, one spelling for common variants, single spaces. */
export function normalizeName(text: string): string {
  return text
    .toLocaleLowerCase("en")
    .replace(/[‌‍]/g, "")
    .replace(/एवम्/g, "एवं")
    .replace(/&/g, " and ")
    .replace(/[(),.\-–/:;"'!?।]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Explicit spaces: \b does not work next to Devanagari.
const DEPT_WORD = /^(?:department|departments|dept|विभाग|विभागों)(?:\s|$)/;
const HINDI = /[ऀ-ॿ]/;

/** Every normalised way of writing this department (names and aliases). */
export function departmentPhrases(department: DepartmentEntry): string[] {
  const all = [department.en, department.hi, department.hi.replace(/\s*विभाग$/, ""), ...department.aliases];
  return [...new Set(all.map(normalizeName).filter((phrase) => phrase.length >= 2))];
}

export function findDepartmentMention(
  query: string,
  departments = loadDepartments(),
): DepartmentMention | null {
  const haystack = ` ${normalizeName(query)} `;
  let best: DepartmentMention | null = null;

  for (const department of departments) {
    for (const phrase of departmentPhrases(department)) {
      // Word boundaries: spaces were normalised, so pad both sides.
      let index = haystack.indexOf(` ${phrase} `);
      if (index < 0 && HINDI.test(phrase)) {
        // Hindi case endings attach directly ("विभागों", "शिक्षा के") — allow a
        // following space or end only, which padding already guarantees.
        index = -1;
      }
      if (index < 0) continue;
      const after = haystack.slice(index + phrase.length + 2);
      const words = phrase.split(" ").length;
      const strength: DepartmentMention["strength"] =
        words >= 2 || phrase.endsWith("विभाग") || DEPT_WORD.test(after) ||
        /\b(?:department|dept) of $/.test(haystack.slice(0, index + 1))
          ? "strong"
          : "weak";
      const candidate = { department, strength, matched: phrase };
      if (
        !best ||
        phrase.length > best.matched.length ||
        (phrase.length === best.matched.length && strength === "strong" && best.strength === "weak")
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

/** "Basic Education (बेसिक शिक्षा विभाग)" or the Hindi name first for Hindi answers. */
export function departmentLabel(department: DepartmentEntry, language: "hi" | "en"): string {
  return language === "hi" ? department.hi : `${department.en} (${department.hi})`;
}

/** The registry entry for a stored department name ("Agriculture", "लोक निर्माण विभाग"). */
export function findDepartmentEntry(name: string, departments = loadDepartments()): DepartmentEntry | undefined {
  const key = normalizeName(name.replace(/\s*(विभाग|department)\s*$/i, ""));
  return departments.find((department) =>
    [department.hi, department.en, ...department.aliases].some(
      (candidate) => normalizeName(candidate.replace(/\s*(विभाग|department)\s*$/i, "")) === key,
    ),
  );
}

/**
 * Every way documents may name the departments in `names`: each name plus its
 * registry entry's Hindi name (with and without "विभाग"), English name and
 * aliases. Scope filters match document names exactly, so a profile that chose
 * "कृषि विभाग" must also match documents filed under "Agriculture".
 */
export function departmentSpellings(names: string[], departments = loadDepartments()): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const clean = name.replace(/[\u200c\u200d]/g, "").replace(/\s+/g, " ").trim();
    if (!clean) continue;
    out.add(clean);
    const entry = findDepartmentEntry(clean, departments);
    if (!entry) continue;
    for (const spelling of [entry.hi, entry.hi.replace(/\s*विभाग$/, ""), entry.en, ...entry.aliases]) {
      if (spelling.trim()) out.add(spelling.trim());
    }
  }
  return [...out];
}

/**
 * One choice per department for the profile picker. Names that resolve to the
 * same registry entry ("कृषि विभाग", "Agriculture") collapse to one: the
 * portal's Hindi name when it is among them, else the first. Returns the
 * choices and, for every name, the choice it belongs to.
 */
export function departmentChoices(
  names: string[],
  departments = loadDepartments(),
): { choices: string[]; choiceOf: Map<string, string>; entryOf: Map<string, DepartmentEntry> } {
  const groups = new Map<string, string[]>();
  const entryOf = new Map<string, DepartmentEntry>();
  for (const name of names) {
    const entry = findDepartmentEntry(name, departments);
    if (entry) entryOf.set(name, entry);
    const key = entry ? `id:${entry.id}` : `name:${normalizeName(name)}`;
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  const choices: string[] = [];
  const choiceOf = new Map<string, string>();
  for (const group of groups.values()) {
    const entry = entryOf.get(group[0]);
    const hiKey = entry ? normalizeName(entry.hi) : null;
    const choice = group.find((name) => hiKey !== null && normalizeName(name) === hiKey) ?? group[0];
    choices.push(choice);
    for (const name of group) choiceOf.set(name, choice);
  }
  return { choices, choiceOf, entryOf };
}

/** A stored department name ("Agriculture", "लोक निर्माण विभाग") in one language. */
export function departmentNameIn(name: string, language: "hi" | "en", departments = loadDepartments()): string {
  const entry = findDepartmentEntry(name, departments);
  if (!entry) return name;
  return language === "hi" ? entry.hi : entry.en;
}
