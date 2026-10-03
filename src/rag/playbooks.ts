/**
 * Topic playbooks (ADR-091).
 *
 * One Markdown file per frequently asked topic in datasets/playbooks/: the
 * ways officers ask it (triggers, English and Hindi), the exact pages that
 * answer it, and how to answer. A question that matches a playbook is
 * answered from those pages directly — no search, so it is faster and the
 * pages are the ones a person checked — with the playbook's guidance in the
 * prompt. The guidance is never evidence: every point is still cited to a page.
 *
 * File format:
 *   ---
 *   id: bidder-experience-criteria
 *   title: Bidder experience (past performance) criteria
 *   triggers:
 *     - past experience
 *     - पूर्व अनुभव
 *   context:            (optional: at least one must also appear)
 *     - bid
 *   pages:
 *     - core-rules-manual-works-2025 p.98
 *   related:
 *     - bidder-turnover-criteria
 *   boost: 0            (optional: added to the score when it matches; a
 *                        narrower topic gets a higher boost so it wins ties)
 *   reviewed: false
 *   ---
 *   ## How to answer
 *   - …
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface PlaybookPage {
  sourceId: string;
  pageNumber: number;
}

export interface Playbook {
  id: string;
  title: string;
  titleHi: string | null;
  triggers: string[];
  context: string[];
  pages: PlaybookPage[];
  related: string[];
  boost: number;
  reviewed: boolean;
  /** The Markdown body: how to answer, points to cover, traps. */
  guidance: string;
}

const PLAYBOOK_DIR = path.resolve(process.env.PLAYBOOK_DIR ?? "datasets/playbooks");
export const PLAYBOOKS_ENABLED = process.env.RAG_PLAYBOOKS !== "0";

/** Parse one playbook file (a small YAML subset: scalars and "- item" lists). */
export function parsePlaybook(text: string, fileName = "playbook"): Playbook {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) throw new Error(`${fileName}: missing --- front matter`);
  const fields: Record<string, string | string[]> = {};
  let currentList: string[] | null = null;
  for (const raw of match[1].split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && currentList) {
      currentList.push(item[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    const pair = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!pair) throw new Error(`${fileName}: cannot read line "${line}"`);
    if (pair[2] === "") {
      currentList = [];
      fields[pair[1]] = currentList;
    } else {
      currentList = null;
      fields[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  const list = (key: string) => (Array.isArray(fields[key]) ? (fields[key] as string[]) : []);
  const scalar = (key: string) => (typeof fields[key] === "string" ? (fields[key] as string) : "");
  const id = scalar("id");
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`${fileName}: id must be lowercase-with-dashes`);
  const pages = list("pages").map((ref) => {
    const page = ref.match(/^(\S+)\s+p\.?\s*(\d+)$/);
    if (!page) throw new Error(`${fileName}: page "${ref}" must look like "source-id p.12"`);
    return { sourceId: page[1], pageNumber: Number(page[2]) };
  });
  if (!pages.length) throw new Error(`${fileName}: no pages`);
  if (!list("triggers").length) throw new Error(`${fileName}: no triggers`);
  return {
    id,
    title: scalar("title") || id,
    titleHi: scalar("title_hi") || null,
    triggers: list("triggers"),
    context: list("context"),
    pages: pages.slice(0, 12),
    related: list("related"),
    boost: Number.isFinite(Number(scalar("boost"))) ? Number(scalar("boost")) : 0,
    reviewed: scalar("reviewed") === "true",
    guidance: match[2].trim(),
  };
}

let cache: Playbook[] | null = null;

export function loadPlaybooks(directory = PLAYBOOK_DIR): Playbook[] {
  if (cache && directory === PLAYBOOK_DIR) return cache;
  const books = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith(".md") && !name.startsWith("_") && name !== "README.md")
        .sort()
        .map((name) => parsePlaybook(readFileSync(path.join(directory, name), "utf8"), name))
    : [];
  if (directory === PLAYBOOK_DIR) cache = books;
  return books;
}

/** Lowercase, no zero-width joiners or nukta, punctuation as spaces. */
export function normalizeForMatch(text: string): string {
  return ` ${text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[‌‍़]/g, "")
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()} `;
}

function contains(haystack: string, phrase: string): boolean {
  const needle = normalizeForMatch(phrase);
  return needle.trim().length > 0 && haystack.includes(needle);
}

export interface PlaybookMatch {
  playbook: Playbook;
  score: number;
  matched: string[];
}

/**
 * The best playbook for a question, or null. Each matched trigger scores its
 * length in words (longer phrases are more specific); context words, when a
 * playbook lists them, must also appear.
 */
export function matchPlaybook(question: string, books = loadPlaybooks()): PlaybookMatch | null {
  if (!PLAYBOOKS_ENABLED || !question.trim()) return null;
  const text = normalizeForMatch(question);
  let best: PlaybookMatch | null = null;
  for (const playbook of books) {
    if (playbook.context.length && !playbook.context.some((word) => contains(text, word))) continue;
    const matched = playbook.triggers.filter((trigger) => contains(text, trigger));
    if (!matched.length) continue;
    const score =
      playbook.boost +
      matched.reduce((sum, trigger) => sum + normalizeForMatch(trigger).trim().split(" ").length, 0);
    if (!best || score > best.score) best = { playbook, score, matched };
  }
  return best;
}
