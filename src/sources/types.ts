export type SourceLanguage = "hi" | "en" | "mixed" | "unknown";

export interface SourceDocument {
  sourceId: string;
  title: string;
  sourceUrl: string;
  downloadUrl: string;
  listingUrls: string[];
  issuer: string;
  jurisdiction: "central" | "state";
  department: string | null;
  documentType: string;
  goDate: string | null;
  goNumber: string | null;
  language: SourceLanguage;
}

export interface SourceAdapter {
  id: string;
  collection: string;
  displayName: string;
  allowedHosts: readonly string[];
  discover(): Promise<SourceDocument[]>;
}
