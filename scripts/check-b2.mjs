#!/usr/bin/env node
/**
 * Read-only Backblaze B2 archive check.
 *
 *   npm run b2:check              local audit + live B2 verification
 *   npm run b2:check -- --offline local audit only
 *
 * Never uploads, deletes or prints credentials. It reports:
 *   - which local captures are archived in B2, not yet archived, or waiting
 *     for a manifest refresh;
 *   - whether the local original.pdf still matches the recorded checksum;
 *   - whether the configured key can authorise, reach the bucket and get an
 *     upload URL; and, when the key can read or list files, whether each
 *     recorded object exists with the expected size and SHA-1.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const offline = process.argv.includes("--offline");
const documentsRoot = path.resolve("data/documents");
let failures = 0;

const sha = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("hex");
const fail = (message) => {
  failures++;
  console.log(`  FAIL  ${message}`);
};

// ---------------------------------------------------------------- local audit
const captures = [];
for (const entry of existsSync(documentsRoot) ? readdirSync(documentsRoot, { withFileTypes: true }) : []) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(documentsRoot, entry.name);
  const metadataPath = path.join(dir, "metadata.json");
  const pdfPath = path.join(dir, "original.pdf");
  if (!existsSync(metadataPath) || !existsSync(pdfPath)) continue;

  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const pdf = readFileSync(pdfPath);
  const storage = metadata.storage;
  captures.push({
    sourceId: metadata.sourceId ?? entry.name,
    collection: storage?.collection ?? (metadata.provider === "doe-gfr" ? "doe-gfr" : "shasanadesh"),
    recordedSha256: metadata.capture?.rawSha256 ?? null,
    localSha256: sha("sha256", pdf),
    localSha1: sha("sha1", pdf),
    bytes: pdf.length,
    storage: storage?.provider === "backblaze-b2-native" && storage.raw?.fileId && storage.metadata?.fileId ? storage : null,
    manifestPending: metadata.storageManifestSyncPending === true,
  });
}

const archived = captures.filter((c) => c.storage);
const notArchived = captures.filter((c) => !c.storage);
const pending = captures.filter((c) => c.manifestPending);

console.log("Local captures");
console.log("==============");
console.log(`Captures with an original PDF: ${captures.length}`);
console.log(`Archived in B2:                ${archived.length}`);
console.log(`Not yet archived:              ${notArchived.length}`);
console.log(`Manifest refresh pending:      ${pending.length}`);

for (const capture of captures) {
  if (capture.recordedSha256 && capture.recordedSha256 !== capture.localSha256) {
    fail(`${capture.sourceId}: local original.pdf no longer matches the recorded SHA-256`);
  }
  if (capture.storage && capture.storage.raw.sha256 && capture.storage.raw.sha256 !== capture.localSha256) {
    fail(`${capture.sourceId}: B2 record SHA-256 differs from the local original.pdf`);
  }
}
if (notArchived.length) {
  console.log("\nNot yet archived:");
  for (const capture of notArchived) console.log(`  - ${capture.sourceId} (${capture.collection})`);
}
if (pending.length) {
  console.log("\nManifest refresh pending:");
  for (const capture of pending) console.log(`  - ${capture.sourceId}`);
}

// ---------------------------------------------------------------- live check
async function b2Json(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  let body = {};
  try {
    body = await response.json();
  } catch {
    // Non-JSON error bodies are reported by status only.
  }
  return { ok: response.ok, status: response.status, body };
}

async function live() {
  console.log("\nBackblaze B2");
  console.log("============");

  const keyId = process.env.B2_KEY_ID?.trim();
  const applicationKey = process.env.B2_APPLICATION_KEY?.trim();
  const bucketName = process.env.B2_BUCKET?.trim() || process.env.B2_BUCKET_NAME?.trim();
  const apiBase = (process.env.B2_NATIVE_API_URL?.trim() || "https://api.backblazeb2.com").replace(/\/$/, "");

  if (!keyId || !applicationKey || !bucketName) {
    fail("B2_KEY_ID, B2_APPLICATION_KEY and B2_BUCKET must all be set in .env");
    return;
  }
  if (process.env.B2_ENDPOINT || process.env.B2_REGION) {
    console.log("  note  B2_ENDPOINT/B2_REGION are S3-API settings and are not used; the uploader uses the Native API.");
  }

  let auth;
  try {
    auth = await b2Json(`${apiBase}/b2api/v4/b2_authorize_account`, {
      headers: { Authorization: "Basic " + Buffer.from(`${keyId}:${applicationKey}`).toString("base64") },
    });
  } catch (error) {
    const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message;
    fail(`cannot reach ${apiBase} (${cause}). Check internet/DNS/VPN and retry.`);
    return;
  }
  if (!auth.ok) {
    fail(`authorisation failed: HTTP ${auth.status} ${auth.body.code ?? ""} ${auth.body.message ?? ""}`.trim());
    return;
  }
  console.log("  ok    key authorised");

  const storageApi = auth.body.apiInfo?.storageApi ?? {};
  const allowed = storageApi.allowed ?? {};
  const capabilities = allowed.capabilities ?? [];
  const buckets = allowed.buckets ?? [];
  console.log(`  info  capabilities: ${capabilities.join(", ") || "(none)"}`);
  console.log(`  info  name prefix:  ${allowed.namePrefix ?? "(none)"}`);

  if (!capabilities.includes("writeFiles") && !capabilities.includes("all")) {
    fail("key lacks writeFiles, so ingestion cannot upload");
  }
  if (buckets.length !== 1) {
    fail("key must be restricted to exactly one bucket (the uploader refuses unrestricted keys)");
    return;
  }
  const bucket = buckets[0];
  if (bucket.name && bucket.name !== bucketName) {
    fail(`key is restricted to bucket "${bucket.name}" but B2_BUCKET is "${bucketName}"`);
    return;
  }
  console.log(`  ok    restricted to bucket ${bucketName}`);
  if (allowed.namePrefix && !"archive/".startsWith(allowed.namePrefix)) {
    fail(`key name prefix "${allowed.namePrefix}" does not allow the archive/ root`);
  }

  const apiUrl = storageApi.apiUrl;
  const token = auth.body.authorizationToken;

  const uploadUrl = await b2Json(
    `${apiUrl}/b2api/v4/b2_get_upload_url?bucketId=${encodeURIComponent(bucket.id)}`,
    { headers: { Authorization: token } },
  );
  if (uploadUrl.ok && uploadUrl.body.uploadUrl) console.log("  ok    upload URL issued (write path works; nothing uploaded)");
  else fail(`could not get an upload URL: HTTP ${uploadUrl.status} ${uploadUrl.body.code ?? ""}`);

  if (archived.length === 0) return;

  const canRead = capabilities.includes("readFiles") || capabilities.includes("all");
  const canList = capabilities.includes("listFiles") || capabilities.includes("all");

  const verify = (capture, kind, remote) => {
    const ref = capture.storage[kind];
    if (!remote) return fail(`${capture.sourceId} ${kind}: object not found (${ref.key})`);
    const size = Number(remote.contentLength);
    const remoteSha1 = remote.contentSha1;
    if (size !== ref.bytes) return fail(`${capture.sourceId} ${kind}: size ${size} != recorded ${ref.bytes}`);
    if (remoteSha1 && remoteSha1 !== "none" && remoteSha1 !== ref.sha1) return fail(`${capture.sourceId} ${kind}: SHA-1 differs from record`);
    if (kind === "raw" && remoteSha1 && remoteSha1 !== "none" && remoteSha1 !== capture.localSha1) {
      return fail(`${capture.sourceId} raw: B2 SHA-1 differs from local original.pdf`);
    }
    console.log(`  ok    ${capture.sourceId} ${kind} (${size} bytes)`);
  };

  if (canRead) {
    for (const capture of archived) {
      for (const kind of ["raw", "metadata"]) {
        const info = await b2Json(
          `${apiUrl}/b2api/v4/b2_get_file_info?fileId=${encodeURIComponent(capture.storage[kind].fileId)}`,
          { headers: { Authorization: token } },
        );
        verify(capture, kind, info.ok ? info.body : null);
      }
    }
  } else if (canList) {
    const byName = new Map();
    let startFileName = null;
    do {
      const page = await b2Json(`${apiUrl}/b2api/v4/b2_list_file_names`, {
        method: "POST",
        headers: { Authorization: token },
        body: JSON.stringify({ bucketId: bucket.id, prefix: "archive/", maxFileCount: 1000, startFileName }),
      });
      if (!page.ok) {
        fail(`could not list files: HTTP ${page.status} ${page.body.code ?? ""}`);
        return;
      }
      for (const file of page.body.files ?? []) byName.set(file.fileName, file);
      startFileName = page.body.nextFileName ?? null;
    } while (startFileName);
    for (const capture of archived) {
      for (const kind of ["raw", "metadata"]) verify(capture, kind, byName.get(capture.storage[kind].key));
    }
  } else {
    console.log("  note  key has neither readFiles nor listFiles, so stored objects cannot be re-verified");
    console.log("        (uploads were verified by size and SHA-1 at upload time).");
  }
}

if (!offline) {
  await live();
}

console.log("\nNext steps");
console.log("==========");
if (notArchived.some((c) => c.collection === "shasanadesh")) console.log("  npm run ingest:known        # backfill Shasanadesh captures to B2 (no re-download)");
if (notArchived.some((c) => c.collection === "doe-gfr")) console.log("  npm run ingest:doe-gfr      # backfill DOE GFR captures to B2");
for (const capture of pending) console.log(`  npm run ocr:needs -- --source-id ${capture.sourceId}   # refresh pending manifest`);
if (failures === 0) console.log(`  ${offline ? "Offline audit" : "B2 check"} passed.`);
else console.log(`  ${failures} problem(s) found above.`);
process.exitCode = failures ? 1 : 0;
