/**
 * Offline test of the B2 Native API uploader against a simulated server.
 * Covers authorization checks, upload checksum verification, retry on 5xx,
 * readable object names, and manifest refresh for legacy object names.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.B2_KEY_ID = "test-key-id";
process.env.B2_APPLICATION_KEY = "test-application-key";
process.env.B2_BUCKET = "shasanadesh";
delete process.env.B2_BUCKET_NAME;
delete process.env.B2_NATIVE_API_URL;

const uploaded = new Map<string, Buffer>();
let failNextUpload = 1; // first upload attempt returns 503 to exercise retry

const sha1 = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex");

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  if (url.pathname.endsWith("/b2_authorize_account")) {
    return json(200, {
      accountId: "acct",
      authorizationToken: "auth-token",
      apiInfo: {
        storageApi: {
          apiUrl: "https://api.example.invalid",
          allowed: {
            buckets: [{ id: "bucket-id", name: "shasanadesh" }],
            capabilities: ["writeFiles"],
            namePrefix: null,
          },
        },
      },
    });
  }

  if (url.pathname.endsWith("/b2_get_upload_url")) {
    assert.equal(url.searchParams.get("bucketId"), "bucket-id");
    return json(200, { uploadUrl: "https://upload.example.invalid/up", authorizationToken: "upload-token" });
  }

  if (url.hostname === "upload.example.invalid") {
    if (failNextUpload > 0) {
      failNextUpload--;
      return json(503, { code: "service_unavailable", message: "try again" });
    }
    const headers = new Headers(init?.headers);
    const name = decodeURIComponent(headers.get("X-Bz-File-Name")!);
    const body = Buffer.from(init?.body as Uint8Array);
    assert.equal(headers.get("X-Bz-Content-Sha1"), sha1(body));
    uploaded.set(name, body);
    return json(200, { fileId: `id-${uploaded.size}`, fileName: name, contentLength: body.length, contentSha1: sha1(body) });
  }

  throw new Error(`Unexpected request: ${url.href}`);
}) as typeof fetch;

async function main(): Promise<void> {
  const { storeCaptureInB2, refreshCaptureManifestInB2, isB2Enabled } = await import("./b2.js");
  assert.equal(isB2Enabled(), true);

  const pdf = Buffer.from("%PDF-1.4 test");
  const storage = await storeCaptureInB2({
    sourceId: "17#46#2#2017",
    captureId: "capture-1",
    pdf,
    metadata: { sourceId: "17#46#2#2017" },
  });

  // Readable names: "#" becomes "-" (no literal %23 folders).
  assert.equal(storage.raw.key, "archive/shasanadesh/raw/17-46-2-2017/capture-1.pdf");
  assert.equal(storage.metadata.key, "archive/shasanadesh/processed/17-46-2-2017/capture-1.metadata.json");
  assert.deepEqual(uploaded.get(storage.raw.key), pdf);
  assert.equal(storage.raw.sha1, sha1(pdf));

  // Refresh uploads only the manifest, next to the existing raw object.
  const before = uploaded.size;
  const refreshed = await refreshCaptureManifestInB2({
    sourceId: "17#46#2#2017",
    captureId: "capture-1",
    metadata: { sourceId: "17#46#2#2017", ocr: { completed: true } },
    storage,
  });
  assert.equal(uploaded.size, before); // same key overwritten, raw not re-uploaded
  assert.equal(refreshed.raw.fileId, storage.raw.fileId);

  // Legacy objects written with percent-encoded names can still be refreshed.
  const legacyStorage = {
    ...storage,
    raw: { ...storage.raw, key: "archive/shasanadesh/raw/17%2346%232%232017/capture-1.pdf" },
  };
  const legacy = await refreshCaptureManifestInB2({
    sourceId: "17#46#2#2017",
    captureId: "capture-1",
    metadata: { sourceId: "17#46#2#2017", ocr: { completed: false } },
    storage: legacyStorage,
  });
  assert.equal(legacy.metadata.key, "archive/shasanadesh/processed/17%2346%232%232017/capture-1.metadata.json");

  // A raw key that matches neither scheme is refused.
  await assert.rejects(
    refreshCaptureManifestInB2({
      sourceId: "17#46#2#2017",
      captureId: "capture-1",
      metadata: {},
      storage: { ...storage, raw: { ...storage.raw, key: "archive/shasanadesh/raw/other/x.pdf" } },
    }),
    /does not match/,
  );

  console.log("b2 uploader tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
