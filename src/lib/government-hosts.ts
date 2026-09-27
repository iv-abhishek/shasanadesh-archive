/**
 * Rulebook §2 (docs/RULES.md, ADR-063): only government sources.
 *
 * A host is a government source when it is under .gov.in or .nic.in (central
 * ministries, every state government, NIC-hosted sites, S3WaaS district
 * sites), or it is on the short, reviewed list of government bodies whose
 * official site uses another domain. Everything else — aggregators, blogs,
 * law portals, document-sharing sites — is private: never ingested, and a
 * document found to come from one is flagged and kept out of answers.
 *
 * Keep apps/web/lib/government-hosts.ts identical (a test compares them).
 */

export const GOVERNMENT_SUFFIXES = [".gov.in", ".nic.in"] as const;

/** Government bodies on other domains: host → who they are (reviewed by hand). */
export const GOVERNMENT_EXCEPTIONS: Record<string, string> = {
  "cert-in.org.in": "CERT-In, Ministry of Electronics and IT (national agency under IT Act s.70B)",
  "www.cert-in.org.in": "CERT-In, Ministry of Electronics and IT (national agency under IT Act s.70B)",
};

export function isGovernmentHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (GOVERNMENT_EXCEPTIONS[name]) return true;
  return GOVERNMENT_SUFFIXES.some((suffix) => name.endsWith(suffix) && name.length > suffix.length);
}

/** True for an http(s) URL on a government host; false for anything else (or unparsable). */
export function isGovernmentUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && isGovernmentHost(url.hostname);
  } catch {
    return false;
  }
}
