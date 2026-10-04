/**
 * The research agent's tools on top of the existing services (ADR-102):
 * hybrid page search with scopes, subject/GO-number order finding, page
 * reading, later-change and amendment lookups, official web search, and the
 * tool-calling model call with the usual primary → backup targets.
 */
import OpenAI from "openai";
import type { Pool } from "pg";
import { browseDocuments } from "../documents/browse.js";
import { findDepartmentEntry, findDepartmentMention } from "../departments/registry.js";
import { amendmentsFor } from "../rag/amendments.js";
import { findLaterChanges } from "../rag/later-changes.js";
import { clientFor, shouldFallBack, type LlmTarget } from "../rag/llm-targets.js";
import { namedRulebooks } from "../rag/named-sources.js";
import { PROCUREMENT_SOURCE_IDS } from "../rag/procurement.js";
import { toRelevance } from "../rag/relevance.js";
import { recordUsage } from "../rag/request-context.js";
import type { RetrievalEvidence } from "../rag/types.js";
import type { SubjectSearch } from "../rag/order-listing.js";
import type { AgentMessage, OrderHit, PageRef, ResearchDeps, SearchScope, ToolSpec } from "./research.js";

export const AGENT_ENABLED = process.env.RAG_AGENT === "1";

const RULEBOOK_PROVIDERS = ["core-rules", "up-fhb", "doe-gfr"];
const ORDER_PROVIDERS = ["shasanadesh-up", "upgov", "invest-up", "uppolice", "gov-cms-msme"];

/** Filters understood by the retrieval service (subset of SearchFiltersSchema). */
export interface AgentSearchFilters {
  sourceIds?: string[];
  providers?: string[];
  departmentIds?: number[];
  dateFrom?: string;
  dateTo?: string;
  includeRoutine?: boolean;
}

export function filtersFor(options: { scope: SearchScope; sources?: string[]; department?: string; dateFrom?: string; dateTo?: string }): AgentSearchFilters {
  const filters: AgentSearchFilters = {};
  const books = namedRulebooks();
  const named = (options.sources ?? [])
    .flatMap((name) => books.find((book) => book.name.toLowerCase() === name.toLowerCase())?.sourceIds ?? [])
    .slice(0, 16);
  if (named.length) filters.sourceIds = named;
  else if (options.scope === "procurement") filters.sourceIds = PROCUREMENT_SOURCE_IDS;
  else if (options.scope === "rulebooks") filters.providers = RULEBOOK_PROVIDERS;
  else if (options.scope === "orders") filters.providers = ORDER_PROVIDERS;
  if (options.department) {
    const entry = findDepartmentEntry(options.department) ?? findDepartmentMention(options.department)?.department;
    if (entry) filters.departmentIds = [entry.id];
  }
  if (options.dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(options.dateFrom)) filters.dateFrom = options.dateFrom;
  if (options.dateTo && /^\d{4}-\d{2}-\d{2}$/.test(options.dateTo)) filters.dateTo = options.dateTo;
  return filters;
}

export interface ServerToolDeps {
  retrieve(query: string, topK: number, filters: AgentSearchFilters, options: { signal?: AbortSignal; expandNeighbors: boolean; preferAuthority: boolean; maxEvidencePages: number; rerankCount?: number; candidateCount?: number }): Promise<{ evidence: RetrievalEvidence[] }>;
  fetchPages(question: string, pages: PageRef[], signal?: AbortSignal): Promise<{ evidence: RetrievalEvidence[] }>;
  searchSubjects: SubjectSearch;
  pool(): Pool;
  webSearch?(query: string): Promise<RetrievalEvidence[]>;
  minRelevance: number;
  targets: LlmTarget[];
  timeoutMs: number;
  signal?: AbortSignal;
  onStatus?(text: string): void;
}

/** Tool-calling model call: primary first, the backup if the primary cannot serve. */
async function callModel(deps: ServerToolDeps, messages: AgentMessage[], tools: ToolSpec[], options?: { forceTool?: string }): Promise<AgentMessage> {
  let lastError: unknown;
  const hosted = deps.targets.filter((target) => !target.local);
  for (const [index, target] of hosted.entries()) {
    try {
      const client = clientFor(target, deps.timeoutMs);
      const response = (await client.chat.completions.create(
        {
          model: target.model,
          messages,
          tools,
          tool_choice: options?.forceTool ? { type: "function", function: { name: options.forceTool } } : "auto",
          parallel_tool_calls: true,
          temperature: 0.1,
          max_tokens: 900 + (target.extraTokens ?? 0),
          usage: { include: true },
          ...target.extraBody,
        } as unknown as Parameters<typeof client.chat.completions.create>[0],
        { signal: deps.signal },
      )) as OpenAI.Chat.Completions.ChatCompletion & { usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
      recordUsage(response.usage);
      const message = response.choices[0]?.message;
      return {
        role: "assistant",
        content: message?.content ?? null,
        tool_calls: (message?.tool_calls ?? [])
          .filter((call) => call.type === "function")
          .map((call, i) => ({
            id: call.id || `call_${i}`,
            type: "function" as const,
            function: { name: (call as { function: { name: string } }).function.name, arguments: (call as { function: { arguments: string } }).function.arguments ?? "{}" },
          })),
      };
    } catch (error) {
      lastError = error;
      if (deps.signal?.aborted || !shouldFallBack(error) || index === hosted.length - 1) throw error;
    }
  }
  throw lastError ?? new Error("No hosted model for the research agent.");
}

// The agent searches several times per question and every search waits for the
// one local reranker; score fewer pages each time (chat's single search uses 24).
const AGENT_RERANK_COUNT = Math.max(6, Math.min(24, Number(process.env.RAG_AGENT_RERANK_COUNT ?? 12) || 12));

export function researchDeps(deps: ServerToolDeps): ResearchDeps {
  // The model often repeats a search word for word in a later round.
  const searches = new Map<string, Promise<RetrievalEvidence[]>>();
  return {
    signal: deps.signal,
    onStatus: deps.onStatus,
    callModel: (messages, tools, options) => callModel(deps, messages, tools, options),

    search(query, options) {
      const key = JSON.stringify([query.trim().toLowerCase(), filtersFor(options)]);
      const cached = searches.get(key);
      if (cached) return cached;
      const pending = (async () => {
        const response = await deps.retrieve(query, 6, filtersFor(options), {
          signal: deps.signal,
          expandNeighbors: false,
          preferAuthority: true,
          maxEvidencePages: 6,
          rerankCount: AGENT_RERANK_COUNT,
          candidateCount: 40,
        });
        // Only pages that pass the usual relevance gate are worth the model's attention.
        const relevance = toRelevance(response.evidence.map((item) => item.rerank_score_raw));
        return response.evidence.filter((_, i) => relevance[i] >= deps.minRelevance);
      })();
      searches.set(key, pending);
      pending.catch(() => searches.delete(key));
      return pending;
    },

    async openPages(question, pages) {
      return (await deps.fetchPages(question, pages, deps.signal)).evidence;
    },

    async findOrders(options) {
      const filters = filtersFor({ scope: "orders", department: options.department, dateFrom: options.dateFrom, dateTo: options.dateTo });
      let hits: Array<{ sourceId: string; similarity?: number }> = [];
      if (options.goNumber) {
        const result = await browseDocuments(deps.pool(), { goNumberPrefix: options.goNumber, governmentOnly: true, pageSize: 10 });
        hits = result.rows.map((row) => ({ sourceId: row.sourceId }));
      }
      if (options.about) {
        const similar = await deps.searchSubjects(options.about, {
          limit: 10,
          departmentIds: filters.departmentIds,
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
        });
        hits.push(...similar.filter((hit) => !hits.some((h) => h.sourceId === hit.sourceId)));
      }
      if (!hits.length) return [];
      const rows = (await browseDocuments(deps.pool(), { sourceIds: hits.map((h) => h.sourceId), governmentOnly: true, pageSize: 20 })).rows;
      return hits.flatMap((hit): OrderHit[] => {
        const row = rows.find((r) => r.sourceId === hit.sourceId);
        return row
          ? [{ sourceId: row.sourceId, title: row.subject, goNumber: row.goNumber, goDate: row.goDate, department: row.department, indexed: row.indexed, similarity: hit.similarity }]
          : [];
      });
    },

    async changes(pages) {
      const lines: string[] = [];
      const later = await findLaterChanges(deps.pool(), pages).catch(() => new Map());
      for (const [sourceId, changes] of later) {
        for (const change of changes as Array<{ kind: string; bySourceId: string; byGoNumber: string | null; byGoDate: string | null }>) {
          lines.push(`${sourceId} is ${change.kind === "amends" ? "amended" : change.kind === "cancels" ? "cancelled" : change.kind === "supersedes" ? "superseded" : "corrected"} by GO ${change.byGoNumber ?? "?"} dated ${change.byGoDate ?? "?"} (open it: ${change.bySourceId})`);
        }
      }
      for (const entry of amendmentsFor(pages)) {
        lines.push(
          `Amendment register: ${entry.rule} — printed at ${entry.rulePages.map((p) => `${p.sourceId} p.${p.pageNumber}`).join(", ")}; current position at ${
            entry.currentPages.map((p) => `${p.sourceId} p.${p.pageNumber}`).join(", ") || "—"
          }; amended by ${entry.amendedBy.map((o) => `GO ${o.goNumber}${o.goDate ? ` (${o.goDate})` : ""}${o.change ? `: ${o.change}` : ""}`).join("; ")}`,
        );
      }
      return lines;
    },

    webSearch: deps.webSearch,
  };
}

export const AGENT_RULEBOOK_NAMES = namedRulebooks().map((book) => book.name);
