/**
 * Rulebook §1 (docs/RULES.md, ADR-063): the chat only ever shows government
 * URLs. Our own archive (local paths, /api/rag/pdf, B2 keys, internal IDs) is
 * for modelling and Q&A improvement and never appears in an answer or a source.
 */

import { isGovernmentUrl } from "./government-hosts.js";

/** The URL itself when it is a government URL; otherwise null (the link is dropped). */
export function officialOnly(url: string | null | undefined): string | null {
  return isGovernmentUrl(url) ? url! : null;
}

// Web addresses, and paths that would reveal the archive.
const URL_RE = /\bhttps?:\/\/[^\s)\]>"'”]+/gi;
const ARCHIVE_PATH_RE = /(?:\/api\/rag\/pdf[^\s)\]]*|\bdata\/documents\/[^\s)\]]*|\barchive\/[a-z0-9-]+\/(?:raw|processed)\/[^\s)\]]*|\blocalhost(?::\d+)?[^\s)\]]*|\b127\.0\.0\.1(?::\d+)?[^\s)\]]*)/gi;

/** Remove non-government URLs and archive paths from text shown in the chat. */
export function stripNonGovernmentLinks(text: string): string {
  return text
    .replace(URL_RE, (url) => (isGovernmentUrl(url.replace(/[.,;:]+$/, "")) ? url : ""))
    .replace(ARCHIVE_PATH_RE, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ");
}
