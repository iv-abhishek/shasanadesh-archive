/**
 * Amendment register (ADR-094): rules in the rulebooks and the government
 * orders that changed them, kept apart and linked.
 *
 * Old rulebooks (Financial Handbook, Fundamental/Subsidiary Rules, CSR) are
 * printed with their text as it stood when compiled; later GOs changed many
 * rules, and those GOs are often not in the archive. Each file in
 * datasets/amendments/ names one rule, the pages where it is printed, the
 * pages that state the current position, and the amending GOs:
 *
 *   ---
 *   id: fhb-sr-153-maternity-leave
 *   rule: Financial Handbook Vol II, Subsidiary Rule 153 — maternity leave
 *   rule_hi: वित्तीय हस्तपुस्तिका खण्ड-2, सहायक नियम 153 — प्रसूति अवकाश
 *   rule_pages:
 *     - up-fhb-vol2 p.183
 *   current_pages:            (optional: a page stating the rule as it is now)
 *     - core-rules-up-vitta-path-09-leave-rules p.9
 *   amended_by:               (GO number | date | source-id p.N or blank | what changed)
 *     - G-4-484/X-90-216-79 | 1990-05-03 | | limit of three maternity leaves removed
 *   reviewed: false
 *   ---
 *   Notes for the answer (optional).
 *
 * When an answer's pages include a registered rule page, a current-position
 * page or an amending GO, the other pages of that entry are added, so the
 * answer can show the rule as printed and the amendment side by side, each
 * with its own citation and link.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RetrievalEvidence } from "./types.js";

export interface RegisterPage {
  sourceId: string;
  pageNumber: number;
}

export interface AmendingOrder {
  goNumber: string;
  goDate: string | null;
  /** The GO's page in the archive, when it is archived. */
  page: RegisterPage | null;
  change: string;
}

export interface AmendmentEntry {
  id: string;
  rule: string;
  ruleHi: string | null;
  rulePages: RegisterPage[];
  currentPages: RegisterPage[];
  amendedBy: AmendingOrder[];
  reviewed: boolean;
  notes: string;
}

const REGISTER_DIR = path.resolve(process.env.AMENDMENT_DIR ?? "datasets/amendments");
export const AMENDMENTS_ENABLED = process.env.RAG_AMENDMENTS !== "0";

function parsePage(ref: string, fileName: string): RegisterPage {
  const match = ref.trim().match(/^(\S+)\s+p\.?\s*(\d+)$/);
  if (!match) throw new Error(`${fileName}: page "${ref}" must look like "source-id p.12"`);
  return { sourceId: match[1], pageNumber: Number(match[2]) };
}

export function parseAmendment(text: string, fileName = "amendment"): AmendmentEntry {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) throw new Error(`${fileName}: missing --- front matter`);
  const fields: Record<string, string | string[]> = {};
  let list: string[] | null = null;
  for (const raw of match[1].split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && list) {
      list.push(item[1].trim());
      continue;
    }
    const pair = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!pair) throw new Error(`${fileName}: cannot read line "${line}"`);
    if (pair[2] === "") {
      list = [];
      fields[pair[1]] = list;
    } else {
      list = null;
      fields[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  const scalar = (key: string) => (typeof fields[key] === "string" ? (fields[key] as string) : "");
  const items = (key: string) => (Array.isArray(fields[key]) ? (fields[key] as string[]) : []);

  const id = scalar("id");
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`${fileName}: id must be lowercase-with-dashes`);
  if (!scalar("rule")) throw new Error(`${fileName}: rule is required`);
  const rulePages = items("rule_pages").map((ref) => parsePage(ref, fileName));
  if (!rulePages.length) throw new Error(`${fileName}: rule_pages is required`);
  const amendedBy = items("amended_by").map((line) => {
    const [goNumber = "", goDate = "", page = "", ...change] = line.split("|").map((part) => part.trim());
    if (!goNumber) throw new Error(`${fileName}: amended_by "${line}" needs a GO number`);
    if (goDate && !/^\d{4}-\d{2}-\d{2}$/.test(goDate)) throw new Error(`${fileName}: date "${goDate}" must be YYYY-MM-DD`);
    return {
      goNumber,
      goDate: goDate || null,
      page: page ? parsePage(page, fileName) : null,
      change: change.join(" | "),
    };
  });
  if (!amendedBy.length) throw new Error(`${fileName}: amended_by is required`);

  return {
    id,
    rule: scalar("rule"),
    ruleHi: scalar("rule_hi") || null,
    rulePages,
    currentPages: items("current_pages").map((ref) => parsePage(ref, fileName)),
    amendedBy,
    reviewed: scalar("reviewed") === "true",
    notes: match[2].trim(),
  };
}

let cache: AmendmentEntry[] | null = null;

export function loadAmendments(directory = REGISTER_DIR): AmendmentEntry[] {
  if (cache && directory === REGISTER_DIR) return cache;
  const entries = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith(".md") && !name.startsWith("_") && name !== "README.md")
        .sort()
        .map((name) => parseAmendment(readFileSync(path.join(directory, name), "utf8"), name))
    : [];
  if (directory === REGISTER_DIR) cache = entries;
  return entries;
}

const key = (sourceId: string, pageNumber: number) => `${sourceId}#${pageNumber}`;

function entryPages(entry: AmendmentEntry): RegisterPage[] {
  return [
    ...entry.rulePages,
    ...entry.currentPages,
    ...entry.amendedBy.flatMap((order) => (order.page ? [order.page] : [])),
  ];
}

/** Register entries touched by the evidence (a rule page, a current page or an amending GO). */
export function amendmentsFor(evidence: RetrievalEvidence[], entries = loadAmendments()): AmendmentEntry[] {
  if (!AMENDMENTS_ENABLED) return [];
  const pages = new Set(evidence.map((item) => key(item.source_id, item.page_number)));
  const amendingSources = new Set(evidence.map((item) => item.source_id));
  return entries.filter(
    (entry) =>
      entryPages(entry).some((page) => pages.has(key(page.sourceId, page.pageNumber))) ||
      entry.amendedBy.some((order) => order.page && amendingSources.has(order.page.sourceId)),
  );
}

/** Pages of the matched entries that are not in the evidence yet (rule first, then current, then GOs). */
export function missingPages(entries: AmendmentEntry[], evidence: RetrievalEvidence[], limit = 6): RegisterPage[] {
  const have = new Set(evidence.map((item) => key(item.source_id, item.page_number)));
  const out: RegisterPage[] = [];
  for (const entry of entries) {
    for (const page of entryPages(entry)) {
      const id = key(page.sourceId, page.pageNumber);
      if (have.has(id)) continue;
      have.add(id);
      out.push(page);
    }
  }
  return out.slice(0, limit);
}

/** Append pages, numbering their labels after the existing ones. */
export function appendEvidence(evidence: RetrievalEvidence[], extra: RetrievalEvidence[]): RetrievalEvidence[] {
  const have = new Set(evidence.map((item) => key(item.source_id, item.page_number)));
  const added = extra.filter((item) => !have.has(key(item.source_id, item.page_number)));
  return [...evidence, ...added].map((item, index) => ({ ...item, label: `S${index + 1}` }));
}

function labelsFor(pages: RegisterPage[], evidence: RetrievalEvidence[]): string[] {
  return pages.flatMap((page) => {
    const item = evidence.find((e) => e.source_id === page.sourceId && e.page_number === page.pageNumber);
    return item ? [`${item.label} p.${item.page_number}`] : [];
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return "date not recorded";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** The prompt block: which evidence pages print the rule, which state it now, which GOs changed it. */
export function amendmentPrompt(entries: AmendmentEntry[], evidence: RetrievalEvidence[], language: "hi" | "en"): string {
  if (!entries.length) return "";
  const lines = [
    "AMENDMENT REGISTER (checked links between rules and the orders that changed them; NOT evidence — cite only evidence pages):",
  ];
  for (const entry of entries) {
    const rule = language === "hi" && entry.ruleHi ? entry.ruleHi : entry.rule;
    const printed = labelsFor(entry.rulePages, evidence);
    const current = labelsFor(entry.currentPages, evidence);
    lines.push(`- Rule: ${rule}`);
    lines.push(`  Printed text (may be out of date): ${printed.join(", ") || "not among the pages"}`);
    if (entry.currentPages.length) lines.push(`  Current position stated on: ${current.join(", ") || "not among the pages"}`);
    for (const order of entry.amendedBy) {
      const onPage = order.page ? labelsFor([order.page], evidence)[0] : undefined;
      lines.push(
        `  Amended by GO ${order.goNumber} dated ${formatDate(order.goDate)}${order.change ? ` — ${order.change}` : ""} (${
          onPage ? `text on ${onPage}` : "GO not in the archive; name it, do not cite it"
        })`,
      );
    }
    if (entry.notes) lines.push(`  Notes: ${entry.notes.replace(/\s+/g, " ")}`);
  }
  lines.push(
    "Answer such a rule in separate parts, each cited: first the current position (from the amending GO or the current-position page), then the rule as printed in the rulebook, then 'Amended by' with each GO's number and date. Never present the printed text as current where the register says it was changed.",
  );
  return lines.join("\n");
}

export interface CardAmendment {
  /** "amended_by" on a rulebook card, "amends" on an amending GO's card. */
  direction: "amended_by" | "amends";
  rule: string;
  goNumber: string;
  goDate: string | null;
  /** The amending GO's archived document, when there is one. */
  goSourceId: string | null;
}

/** Notes for the source cards: the rule's card lists its amending GOs; a GO's card says which rule it amends. */
export function cardAmendments(entries: AmendmentEntry[], language: "hi" | "en"): Map<string, CardAmendment[]> {
  const out = new Map<string, CardAmendment[]>();
  const add = (sourceId: string, note: CardAmendment) => {
    const list = out.get(sourceId) ?? [];
    if (!list.some((n) => n.direction === note.direction && n.goNumber === note.goNumber && n.rule === note.rule)) list.push(note);
    out.set(sourceId, list);
  };
  for (const entry of entries) {
    const rule = language === "hi" && entry.ruleHi ? entry.ruleHi : entry.rule;
    // Only the rulebook that prints the rule; a compilation that already
    // states the current position is not "amended".
    const ruleSources = new Set(entry.rulePages.map((page) => page.sourceId));
    for (const order of entry.amendedBy) {
      const goSourceId = order.page?.sourceId ?? null;
      const note = { rule, goNumber: order.goNumber, goDate: order.goDate, goSourceId };
      for (const sourceId of ruleSources) add(sourceId, { direction: "amended_by", ...note });
      if (goSourceId) add(goSourceId, { direction: "amends", ...note });
    }
  }
  return out;
}
