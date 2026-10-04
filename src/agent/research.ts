/**
 * Research agent (ADR-102): the model decides how to find the pages that
 * answer a question, using tools, instead of one fixed search.
 *
 * Phase 1 (here): a tool-calling loop. The model may search the archive (all,
 * rulebooks only, the procurement rulebooks, named rulebooks, a department),
 * find orders by subject or GO number, open pages, check amendments and later
 * orders, and search official websites when the archive has nothing. Every
 * page a tool returns is registered once (S1, S2 …) with its full text kept
 * here; the model sees short snippets. It ends by calling `finish` with the
 * pages that answer.
 *
 * Phase 2 (unchanged, server.ts): the chosen pages go to the usual writer,
 * validator, repair and salvage, so every point is still cited and checked.
 *
 * The loop is bounded (steps, tool calls, time) and every dependency is
 * injected, so it is tested without the model, the database or the network.
 */
import type { RetrievalEvidence } from "../rag/types.js";

export interface PageRef {
  sourceId: string;
  pageNumber: number;
}

export interface OrderHit {
  sourceId: string;
  title: string | null;
  goNumber: string | null;
  goDate: string | null;
  department: string | null;
  indexed: boolean;
  similarity?: number;
}

export type SearchScope = "all" | "rulebooks" | "procurement" | "orders";

export interface ResearchDeps {
  search(query: string, options: { scope: SearchScope; sources?: string[]; department?: string; dateFrom?: string; dateTo?: string }): Promise<RetrievalEvidence[]>;
  openPages(question: string, pages: PageRef[]): Promise<RetrievalEvidence[]>;
  findOrders(options: { about?: string; goNumber?: string; department?: string; dateFrom?: string; dateTo?: string }): Promise<OrderHit[]>;
  /** Plain-language lines about amendments and later orders for these pages. */
  changes(evidence: RetrievalEvidence[]): Promise<string[]>;
  webSearch?(query: string): Promise<RetrievalEvidence[]>;
  /** forceTool: the model must call this tool (the last round must finish). */
  callModel(messages: AgentMessage[], tools: ToolSpec[], options?: { forceTool?: string }): Promise<AgentMessage>;
  onStatus?(text: string): void;
  signal?: AbortSignal;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ResearchLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxMs: number;
  maxFinalPages: number;
}

export const DEFAULT_LIMITS: ResearchLimits = { maxSteps: 5, maxToolCalls: 10, maxMs: 45_000, maxFinalPages: 10 };

export interface ResearchTrace {
  tool: string;
  args: Record<string, unknown>;
  found: number;
  ms: number;
  error?: string;
}

export interface ResearchResult {
  evidence: RetrievalEvidence[];
  answerable: boolean | null;
  note: string | null;
  steps: number;
  trace: ResearchTrace[];
  usedWeb: boolean;
  ms: number;
  stoppedBy: "finish" | "no_tool_call" | "steps" | "tool_calls" | "time";
}

export interface ResearchContext {
  question: string;
  language: "hi" | "en";
  today: string;
  /** Short facts for the plan: playbook, procurement order, rulebook names, officer's departments. */
  hints: string[];
  rulebookNames: string[];
  /** Pages opened before the loop (e.g. a playbook's pinned pages). */
  preloaded?: RetrievalEvidence[];
}

const key = (sourceId: string, pageNumber: number) => `${sourceId}#${pageNumber}`;

/** Pages seen so far, numbered in the order the model first saw them. */
class PageRegistry {
  private pages = new Map<string, RetrievalEvidence & { tag: string }>();
  private order: string[] = [];

  add(items: RetrievalEvidence[]): Array<RetrievalEvidence & { tag: string }> {
    return items.map((item) => {
      const id = key(item.source_id, item.page_number);
      const known = this.pages.get(id);
      if (known) {
        // Keep the better score when a page comes back from another search.
        if ((item.rerank_score_raw ?? 0) > (known.rerank_score_raw ?? 0)) known.rerank_score_raw = item.rerank_score_raw;
        return known;
      }
      const entry = { ...item, tag: `P${this.order.length + 1}` };
      this.pages.set(id, entry);
      this.order.push(id);
      return entry;
    });
  }

  byTag(tag: string): (RetrievalEvidence & { tag: string }) | undefined {
    const wanted = tag.trim().toUpperCase();
    for (const id of this.order) {
      const page = this.pages.get(id)!;
      if (page.tag === wanted) return page;
    }
    return undefined;
  }

  all(): Array<RetrievalEvidence & { tag: string }> {
    return this.order.map((id) => this.pages.get(id)!);
  }
}

function snippet(item: RetrievalEvidence, length = 500): string {
  const text = (item.matched_chunk_text || item.selected_page_text || "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function describePage(item: RetrievalEvidence & { tag: string }): string {
  const title = (item.document_title ?? item.source_id).replace(/\s+/g, " ").slice(0, 120);
  const go = [item.go_number, item.go_date].filter(Boolean).join(", ");
  const kind = item.provider === "web-official" ? "official website" : item.tier === "A" || item.provider === "core-rules" || item.provider === "up-fhb" ? "rule/general" : "order";
  const where = item.jurisdiction_code === "IN" ? "central" : item.jurisdiction_code === "UP" ? "UP" : "";
  const score = Number.isFinite(item.rerank_score_raw) ? ` | match ${(item.rerank_score_raw > 1 || item.rerank_score_raw < 0 ? 1 / (1 + Math.exp(-item.rerank_score_raw)) : item.rerank_score_raw).toFixed(2)}` : "";
  return `${item.tag} | ${title}${go ? ` (${go})` : ""} | ${item.source_id} p.${item.page_number} | ${[kind, where].filter(Boolean).join(", ")}${score}\n   ${snippet(item)}`;
}

export function toolSpecs(rulebookNames: string[], webAvailable: boolean): ToolSpec[] {
  const specs: ToolSpec[] = [
    {
      type: "function",
      function: {
        name: "search_pages",
        description:
          "Search page text of the archive (Uttar Pradesh government orders, rulebooks, manuals). Returns the best pages with a snippet. Use specific official wording; Hindi and English both work. Run several searches in parallel for different angles.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to look for, in the words a rule or order would use." },
            scope: {
              type: "string",
              enum: ["all", "rulebooks", "procurement", "orders"],
              description: "all (default); rulebooks = rule books and manuals only; procurement = UP GeM GOs, GeM GTC, GFR, procurement manuals, UP Procurement Manual; orders = government orders only.",
            },
            sources: { type: "array", items: { type: "string", enum: rulebookNames }, description: "Search only inside these named rulebooks." },
            department: { type: "string", description: "Department name to search within (orders)." },
            date_from: { type: "string", description: "YYYY-MM-DD" },
            date_to: { type: "string", description: "YYYY-MM-DD" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "find_orders",
        description:
          "Find specific government orders by what their subject is about, by GO number, department or date. Returns orders (not pages). Then open_pages to read them.",
        parameters: {
          type: "object",
          properties: {
            about: { type: "string", description: "Subject of the order (scheme, institution, post, place, topic)." },
            go_number: { type: "string" },
            department: { type: "string" },
            date_from: { type: "string" },
            date_to: { type: "string" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "open_pages",
        description:
          "Read pages: by tag from earlier results (\"P3\"), by \"<source_id> p.<n>\", or by \"<source_id>\" alone for its first pages. Use it for the page after a cut-off rule, or to read an order found with find_orders.",
        parameters: {
          type: "object",
          properties: { refs: { type: "array", items: { type: "string" }, maxItems: 6 } },
          required: ["refs"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "check_changes",
        description: "For pages already found (tags), list later orders that amend, supersede or cancel them, and rulebook amendments on record.",
        parameters: {
          type: "object",
          properties: { tags: { type: "array", items: { type: "string" }, maxItems: 8 } },
          required: ["tags"],
        },
      },
    },
  ];
  if (webAvailable) {
    specs.push({
      type: "function",
      function: {
        name: "search_official_web",
        description: "Search official government websites (UP first, then central). Only when the archive has nothing that answers.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    });
  }
  specs.push({
    type: "function",
    function: {
      name: "finish",
      description:
        "Stop researching. List the tags of the pages that answer the question, most authoritative first (include a rule and the order that amends it). answerable=false if nothing found answers it.",
      parameters: {
        type: "object",
        properties: {
          pages: { type: "array", items: { type: "string" }, maxItems: 10 },
          answerable: { type: "boolean" },
          note: { type: "string", description: "One line: what the pages cover or what is missing." },
        },
        required: ["pages", "answerable"],
      },
    },
  });
  return specs;
}

export function systemPrompt(context: ResearchContext): string {
  return [
    "You are the research step of Sandarbh, an assistant for Uttar Pradesh government officers. You do not write the answer: you find the pages that answer the question, then call finish.",
    `Today is ${context.today}.`,
    "How to research:",
    "- Start with 2–3 parallel searches from different angles (official wording; Hindi and English; the rulebook and the GO).",
    "- Prefer rules and general orders over individual orders; a UP order over a central rule for UP staff; the latest order over older ones.",
    "- When a rule may have been changed, look for the amending order (check_changes, or search for it) and keep both.",
    "- When a question names an order, scheme, institution or GO number, use find_orders, then open_pages.",
    "- When a page breaks off mid-rule, open the next page.",
    "- Use search_official_web only if the archive has nothing that answers.",
    "- Stop as soon as you have the pages that answer (usually 2–6 pages; at most 5 rounds of tools). Call finish with their tags.",
    ...(context.hints.length ? ["", "Known for this question:", ...context.hints.map((hint) => `- ${hint}`)] : []),
  ].join("\n");
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const asString = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
/**
 * A list argument. Models sometimes send it as a JSON string ("[\"P1\"]") or a
 * comma-separated string instead of an array (DeepSeek, 4 Oct live check).
 */
export function asStrings(value: unknown): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      return asStrings(JSON.parse(text));
    } catch {
      return text.split(",").map((part) => part.trim()).filter(Boolean);
    }
  }
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()) : [];
}

function statusFor(name: string, args: Record<string, unknown>, language: "hi" | "en"): string {
  const q = asString(args.query) ?? asString(args.about) ?? asString(args.go_number) ?? "";
  const short = q.length > 60 ? `${q.slice(0, 57)}…` : q;
  const hi = language === "hi";
  switch (name) {
    case "search_pages":
      return hi ? `खोज: ${short}` : `Searching: ${short}`;
    case "find_orders":
      return hi ? `आदेश ढूँढ रहे हैं: ${short}` : `Finding orders: ${short}`;
    case "open_pages":
      return hi ? "पृष्ठ पढ़ रहे हैं" : "Reading pages";
    case "check_changes":
      return hi ? "बाद के संशोधन देख रहे हैं" : "Checking later amendments";
    case "search_official_web":
      return hi ? `सरकारी वेबसाइटों में खोज: ${short}` : `Searching official websites: ${short}`;
    default:
      return hi ? "जाँच" : "Checking";
  }
}

/** "P3", "core-rules-gfr-2017 p.43", "core-rules-gfr-2017" → page refs or registered pages. */
export function parseRef(ref: string): { tag?: string; page?: PageRef; sourceId?: string } {
  const text = ref.trim();
  if (/^P\d+$/i.test(text)) return { tag: text.toUpperCase() };
  const page = text.match(/^(\S+)\s+p\.?\s*(\d+)$/i);
  if (page) return { page: { sourceId: page[1], pageNumber: Number(page[2]) } };
  if (/^\S+$/.test(text)) return { sourceId: text };
  return {};
}

export async function research(context: ResearchContext, deps: ResearchDeps, limits: ResearchLimits = DEFAULT_LIMITS): Promise<ResearchResult> {
  const started = performance.now();
  const registry = new PageRegistry();
  const trace: ResearchTrace[] = [];
  const tools = toolSpecs(context.rulebookNames, Boolean(deps.webSearch));
  let usedWeb = false;
  let toolCalls = 0;

  const opening = context.preloaded?.length
    ? `\n\nAlready open (a checked list of pages for this topic):\n${registry.add(context.preloaded).map(describePage).join("\n")}`
    : "";
  const messages: AgentMessage[] = [
    { role: "system", content: systemPrompt(context) },
    { role: "user", content: `Question: ${context.question}${opening}` },
  ];

  const finishWith = (
    stoppedBy: ResearchResult["stoppedBy"],
    chosen: string[] | null,
    answerable: boolean | null,
    note: string | null,
    steps: number,
  ): ResearchResult => {
    const all = registry.all();
    let picked = (chosen ?? []).map((tag) => registry.byTag(tag)).filter((page): page is RetrievalEvidence & { tag: string } => Boolean(page));
    if (!picked.length && answerable !== false) {
      // No explicit choice: the best-matching pages seen.
      picked = [...all].sort((a, b) => (b.rerank_score_raw ?? 0) - (a.rerank_score_raw ?? 0)).slice(0, limits.maxFinalPages);
    }
    const unique = [...new Map(picked.map((page) => [key(page.source_id, page.page_number), page])).values()].slice(0, limits.maxFinalPages);
    const evidence = unique.map(({ tag: _tag, ...page }, index) => ({ ...page, label: `S${index + 1}`, retrieval_role: "direct" as const }));
    return { evidence, answerable, note, steps, trace, usedWeb, ms: performance.now() - started, stoppedBy };
  };

  const runTool = async (call: ToolCall): Promise<{ content: string; finish?: { pages: string[]; answerable: boolean; note: string | null } }> => {
    const args = parseArgs(call.function.arguments);
    const name = call.function.name;
    const t0 = performance.now();
    const record = (found: number, error?: string) => trace.push({ tool: name, args, found, ms: Math.round(performance.now() - t0), ...(error ? { error } : {}) });
    if (name === "finish") {
      record(asStrings(args.pages).length);
      return { content: "ok", finish: { pages: asStrings(args.pages), answerable: args.answerable !== false, note: asString(args.note) ?? null } };
    }
    if (toolCalls >= limits.maxToolCalls) {
      record(0, "limit");
      return { content: "Tool limit reached: call finish now with the pages found." };
    }
    toolCalls++;
    deps.onStatus?.(statusFor(name, args, context.language));
    try {
      switch (name) {
        case "search_pages": {
          const query = asString(args.query);
          if (!query) throw new Error("query is required");
          const scope = (["all", "rulebooks", "procurement", "orders"] as const).find((s) => s === args.scope) ?? "all";
          const found = registry.add(
            await deps.search(query, {
              scope,
              sources: asStrings(args.sources),
              department: asString(args.department),
              dateFrom: asString(args.date_from),
              dateTo: asString(args.date_to),
            }),
          );
          record(found.length);
          return { content: found.length ? found.map(describePage).join("\n") : "No page matched. Try other wording, another scope, or find_orders." };
        }
        case "find_orders": {
          const orders = await deps.findOrders({
            about: asString(args.about),
            goNumber: asString(args.go_number),
            department: asString(args.department),
            dateFrom: asString(args.date_from),
            dateTo: asString(args.date_to),
          });
          record(orders.length);
          return {
            content: orders.length
              ? orders
                  .slice(0, 10)
                  .map((o) => `${o.sourceId} | ${(o.title ?? "").slice(0, 140)} | ${[o.goNumber, o.goDate, o.department].filter(Boolean).join(", ")}${o.indexed ? "" : " | text not yet in the archive"}`)
                  .join("\n")
              : "No order matched.",
          };
        }
        case "open_pages": {
          const refs = asStrings(args.refs).slice(0, 6).map(parseRef);
          const wanted: PageRef[] = [];
          for (const ref of refs) {
            if (ref.page) wanted.push(ref.page);
            else if (ref.sourceId) wanted.push({ sourceId: ref.sourceId, pageNumber: 1 }, { sourceId: ref.sourceId, pageNumber: 2 });
            else if (ref.tag) {
              const page = registry.byTag(ref.tag);
              if (page) wanted.push({ sourceId: page.source_id, pageNumber: page.page_number });
            }
          }
          const found = wanted.length ? registry.add(await deps.openPages(context.question, wanted.slice(0, 8))) : [];
          record(found.length);
          return { content: found.length ? found.map((page) => describePage({ ...page, matched_chunk_text: page.selected_page_text?.slice(0, 1500) ?? page.matched_chunk_text })).join("\n") : "Those pages could not be opened." };
        }
        case "check_changes": {
          const pages = asStrings(args.tags).map((tag) => registry.byTag(tag)).filter((page): page is RetrievalEvidence & { tag: string } => Boolean(page));
          const lines = pages.length ? await deps.changes(pages) : [];
          record(lines.length);
          return { content: lines.length ? lines.join("\n") : "No later order or amendment on record for these pages." };
        }
        case "search_official_web": {
          const query = asString(args.query);
          if (!query || !deps.webSearch) throw new Error("web search unavailable");
          const found = registry.add(await deps.webSearch(query));
          usedWeb ||= found.length > 0;
          record(found.length);
          return { content: found.length ? found.map(describePage).join("\n") : "No official page found." };
        }
        default:
          record(0, "unknown tool");
          return { content: `Unknown tool ${name}.` };
      }
    } catch (error) {
      if (deps.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      record(0, message);
      return { content: `Tool failed: ${message}` };
    }
  };

  for (let step = 1; step <= limits.maxSteps; step++) {
    deps.signal?.throwIfAborted();
    if (performance.now() - started > limits.maxMs) return finishWith("time", null, null, null, step - 1);
    // The last round must choose pages: only `finish` is allowed then.
    const last = step === limits.maxSteps || toolCalls >= limits.maxToolCalls;
    const reply = await deps.callModel(messages, last ? tools.filter((t) => t.function.name === "finish") : tools, last ? { forceTool: "finish" } : undefined);
    const calls = reply.role === "assistant" ? reply.tool_calls ?? [] : [];
    messages.push(reply.role === "assistant" ? { role: "assistant", content: reply.content ?? "", tool_calls: calls.length ? calls : undefined } : reply);
    if (!calls.length) return finishWith("no_tool_call", null, null, null, step);

    const results = await Promise.all(calls.map(runTool));
    const finished = results.find((result) => result.finish)?.finish;
    calls.forEach((call, index) => messages.push({ role: "tool", tool_call_id: call.id, content: results[index].content.slice(0, 6000) }));
    if (finished) return finishWith("finish", finished.pages, finished.answerable, finished.note, step);
    if (toolCalls >= limits.maxToolCalls || step === limits.maxSteps - 1) {
      messages.push({ role: "user", content: "Enough research: call finish now with the tags of the pages that answer." });
    }
  }
  return finishWith("steps", null, null, null, limits.maxSteps);
}
