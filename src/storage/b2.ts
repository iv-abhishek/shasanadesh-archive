import { createHash } from "node:crypto";

const ARCHIVE_ROOT = "archive/";
const MAX_SINGLE_UPLOAD_BYTES = 5_000_000_000;

interface B2Config {
  keyId: string;
  applicationKey: string;
  bucketName: string;
  nativeApiUrl: string;
}

interface B2Bucket {
  id: string;
  name: string | null;
}

interface B2Authorization {
  accountId: string;
  authorizationToken: string;
  apiInfo: {
    storageApi: {
      apiUrl: string;
      allowed: {
        buckets: B2Bucket[];
        capabilities: string[];
        namePrefix: string | null;
      };
    };
  };
}

interface B2UploadTarget {
  uploadUrl: string;
  authorizationToken: string;
}

interface B2UploadResponse {
  fileId: string;
  fileName: string;
  contentLength: number;
  contentSha1: string;
}

export interface B2ObjectReference {
  key: string;
  fileId: string;
  bytes: number;
  sha1: string;
  sha256: string;
  uploadedAt: string;
}

export interface B2CaptureStorage {
  provider: "backblaze-b2-native";
  bucket: string;
  collection: string;
  raw: B2ObjectReference;
  metadata: B2ObjectReference;
}

interface UploadContext {
  config: B2Config;
  bucketId: string;
  apiUrl: string;
  authorizationToken: string;
}

let authorizationPromise: Promise<UploadContext> | null = null;
let uploadTargetPromise: Promise<B2UploadTarget> | null = null;

function readConfig(): B2Config | null {
  const keyId = process.env.B2_KEY_ID?.trim() ?? "";
  const applicationKey = process.env.B2_APPLICATION_KEY?.trim() ?? "";
  const bucketName =
    process.env.B2_BUCKET?.trim() || process.env.B2_BUCKET_NAME?.trim() || "";
  const nativeApiUrl =
    process.env.B2_NATIVE_API_URL?.trim() || "https://api.backblazeb2.com";

  const supplied = [keyId, applicationKey, bucketName].filter(Boolean).length;
  if (supplied === 0) return null;
  if (supplied !== 3) {
    throw new Error(
      "B2 is partially configured. Set B2_KEY_ID, B2_APPLICATION_KEY, and either B2_BUCKET or B2_BUCKET_NAME together.",
    );
  }

  const endpoint = new URL(nativeApiUrl);
  if (endpoint.protocol !== "https:" || endpoint.pathname !== "/") {
    throw new Error("B2_NATIVE_API_URL must be an HTTPS API base URL.");
  }

  return {
    keyId,
    applicationKey,
    bucketName,
    nativeApiUrl: endpoint.origin,
  };
}

export function isB2Enabled(): boolean {
  const config = readConfig();
  if (!config && process.env.B2_REQUIRED === "1") {
    throw new Error(
      "B2_REQUIRED=1, but B2_KEY_ID, B2_APPLICATION_KEY, and either B2_BUCKET or B2_BUCKET_NAME are not configured.",
    );
  }
  return config !== null;
}

function sha1(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function apiError(
  response: Response,
  body: Record<string, unknown>,
): Error & { status: number } {
  const code = typeof body.code === "string" ? `${body.code}: ` : "";
  const message =
    typeof body.message === "string" ? body.message : response.statusText;
  return Object.assign(
    new Error(`Backblaze B2 returned HTTP ${response.status}: ${code}${message}`),
    { status: response.status },
  );
}

async function authorize(): Promise<UploadContext> {
  const config = readConfig();
  if (!config) {
    throw new Error("Backblaze B2 is not configured.");
  }

  const basicAuth = Buffer.from(
    `${config.keyId}:${config.applicationKey}`,
  ).toString("base64");
  const response = await fetch(
    `${config.nativeApiUrl}/b2api/v4/b2_authorize_account`,
    {
      headers: { Authorization: `Basic ${basicAuth}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = await responseJson(response);
  if (!response.ok) throw apiError(response, body);

  const authorization = body as unknown as B2Authorization;
  const storageApi = authorization.apiInfo?.storageApi;
  if (!authorization.authorizationToken || !storageApi?.apiUrl) {
    throw new Error("Backblaze B2 authorization response is missing storage details.");
  }

  const allowed = storageApi.allowed;
  if (
    !allowed?.capabilities?.includes("writeFiles") &&
    !allowed?.capabilities?.includes("all")
  ) {
    throw new Error("The Backblaze application key needs the writeFiles capability.");
  }

  if (
    allowed.namePrefix &&
    !ARCHIVE_ROOT.startsWith(allowed.namePrefix)
  ) {
    throw new Error(
      `The Backblaze application key prefix must allow the ${ARCHIVE_ROOT} archive root.`,
    );
  }

  const buckets = allowed.buckets ?? [];
  if (buckets.length !== 1) {
    throw new Error(
      "The Backblaze application key must be restricted to exactly the configured bucket.",
    );
  }
  const bucket = buckets.find((candidate) => candidate.name === config.bucketName);
  const onlyUnnamedAllowedBucket =
    buckets.length === 1 && buckets[0].name === null ? buckets[0] : null;
  const selectedBucket = bucket ?? onlyUnnamedAllowedBucket;
  if (!selectedBucket?.id) {
    throw new Error(
      `The Backblaze application key must be restricted to bucket ${config.bucketName}; its allowed buckets did not identify that bucket.`,
    );
  }

  return {
    config,
    bucketId: selectedBucket.id,
    apiUrl: storageApi.apiUrl.replace(/\/$/, ""),
    authorizationToken: authorization.authorizationToken,
  };
}

async function getAuthorization(
  refresh = false,
): Promise<UploadContext> {
  if (refresh) {
    authorizationPromise = null;
    uploadTargetPromise = null;
  }
  if (!authorizationPromise) {
    const pending = authorize();
    authorizationPromise = pending;
    pending.catch(() => {
      if (authorizationPromise === pending) authorizationPromise = null;
    });
  }
  return authorizationPromise;
}

async function getUploadTarget(
  context: UploadContext,
  refresh = false,
): Promise<B2UploadTarget> {
  if (refresh) uploadTargetPromise = null;
  if (!uploadTargetPromise) {
    const pending = (async () => {
      const url = new URL(`${context.apiUrl}/b2api/v4/b2_get_upload_url`);
      url.searchParams.set("bucketId", context.bucketId);
      const response = await fetch(url, {
        headers: { Authorization: context.authorizationToken },
        signal: AbortSignal.timeout(30_000),
      });
      const body = await responseJson(response);
      if (!response.ok) throw apiError(response, body);

      const target = body as unknown as B2UploadTarget;
      if (!target.uploadUrl || !target.authorizationToken) {
        throw new Error("Backblaze B2 did not return a usable upload URL.");
      }
      return target;
    })();
    uploadTargetPromise = pending;
    pending.catch(() => {
      if (uploadTargetPromise === pending) uploadTargetPromise = null;
    });
  }
  return uploadTargetPromise;
}

async function uploadObject(
  key: string,
  bytes: Buffer,
  contentType: string,
): Promise<B2ObjectReference> {
  if (bytes.byteLength > MAX_SINGLE_UPLOAD_BYTES) {
    throw new Error(
      `B2 single-file upload limit exceeded for ${key}; large-file upload is not implemented.`,
    );
  }

  const expectedSha1 = sha1(bytes);
  const expectedSha256 = sha256(bytes);
  let activeContext = await getAuthorization();
  let lastError: unknown;

  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) {
      // Back off before retrying transient network / 5xx / expired-token errors.
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 2)));
    }
    try {
      const target = await getUploadTarget(activeContext, attempt > 1);
      const response = await fetch(target.uploadUrl, {
        method: "POST",
        headers: {
          Authorization: target.authorizationToken,
          "X-Bz-File-Name": encodeURIComponent(key),
          "X-Bz-Content-Sha1": expectedSha1,
          "X-Bz-Info-sha256": expectedSha256,
          "Content-Type": contentType,
        },
        // Node derives an exact Content-Length from this in-memory byte buffer;
        // B2's Native API does not accept chunked uploads.
        // Node fetch accepts Buffer as Uint8Array; DOM typings model a narrower backing buffer.
        body: bytes as unknown as BodyInit,
        signal: AbortSignal.timeout(120_000),
      });
      const body = await responseJson(response);
      if (!response.ok) {
        const error = apiError(response, body) as Error & { status: number };
        if (error.status >= 500 || error.status === 401) {
          lastError = error;
          if (error.status === 401) {
            activeContext = await getAuthorization(true);
          }
          continue;
        }
        throw error;
      }

      const uploaded = body as unknown as B2UploadResponse;
      if (
        !uploaded.fileId ||
        uploaded.contentSha1 !== expectedSha1 ||
        Number(uploaded.contentLength) !== bytes.byteLength
      ) {
        throw Object.assign(
          new Error(
            `Backblaze B2 upload verification failed for ${key}: response checksum or byte count did not match.`,
          ),
          { status: 409 },
        );
      }

      return {
        key,
        fileId: uploaded.fileId,
        bytes: bytes.byteLength,
        sha1: expectedSha1,
        sha256: expectedSha256,
        uploadedAt: new Date().toISOString(),
      };
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status !== undefined && status < 500 && status !== 401) throw error;
      lastError = error;
      if (status === 401) {
        activeContext = await getAuthorization(true);
      }
      if (attempt < 5) continue;
    }
  }

  throw new Error(
    `Backblaze B2 upload failed after five attempts for ${key}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * Object-name segment for a source or capture ID.
 *
 * Shasanadesh IDs contain "#", which previously went through
 * encodeURIComponent and produced literal "%23" folder names in the bucket.
 * "#" is now mapped to "-", matching the local data/documents directory names.
 */
function objectPathSegment(value: string): string {
  const segment = value.replaceAll("#", "-");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(segment)) {
    throw new Error(`Unsupported characters in B2 object path segment: ${value}`);
  }
  return segment;
}

// Name scheme used before objectPathSegment; kept so existing objects can
// still have their manifests refreshed in place.
function legacyPathSegment(value: string): string {
  return encodeURIComponent(value);
}

export async function storeCaptureInB2(input: {
  collection?: string;
  sourceId: string;
  captureId: string;
  pdf: Buffer;
  metadata: Record<string, unknown>;
}): Promise<B2CaptureStorage> {
  const context = await getAuthorization();
  const collection = input.collection ?? "shasanadesh";
  if (!/^[a-z0-9-]+$/.test(collection)) {
    throw new Error("B2 collection names may contain lowercase letters, digits, and hyphens only.");
  }
  const archivePrefix = `${ARCHIVE_ROOT}${collection}/`;
  const sourcePath = objectPathSegment(input.sourceId);
  const capturePath = objectPathSegment(input.captureId);
  const rawKey = `${archivePrefix}raw/${sourcePath}/${capturePath}.pdf`;
  const metadataKey = `${archivePrefix}processed/${sourcePath}/${capturePath}.metadata.json`;

  const raw = await uploadObject(rawKey, input.pdf, "application/pdf");
  const remoteManifest = {
    ...input.metadata,
    storage: {
      provider: "backblaze-b2-native",
      bucket: context.config.bucketName,
      collection,
      raw,
      metadata: { key: metadataKey },
    },
  };
  const metadataBytes = Buffer.from(
    `${JSON.stringify(remoteManifest, null, 2)}\n`,
    "utf8",
  );
  const metadata = await uploadObject(metadataKey, metadataBytes, "application/json");

  return {
    provider: "backblaze-b2-native",
    bucket: context.config.bucketName,
    collection,
    raw,
    metadata,
  };
}

/**
 * Refresh only the provenance manifest after local OCR/page metadata changes.
 * The immutable raw PDF is not uploaded again.
 */
export async function refreshCaptureManifestInB2(input: {
  sourceId: string;
  captureId: string;
  metadata: Record<string, unknown>;
  storage: B2CaptureStorage;
}): Promise<B2CaptureStorage> {
  const context = await getAuthorization();
  const collection = input.storage.collection;
  if (!/^[a-z0-9-]+$/.test(collection)) {
    throw new Error("B2 collection names may contain lowercase letters, digits, and hyphens only.");
  }
  if (input.storage.bucket !== context.config.bucketName) {
    throw new Error("The stored B2 capture belongs to a different configured bucket.");
  }

  const archivePrefix = ARCHIVE_ROOT + collection + "/";
  // Accept the current name scheme and the legacy percent-encoded one, and
  // keep writing the manifest next to whichever raw object already exists.
  const keySchemes = [objectPathSegment, legacyPathSegment].map((segment) => {
    const sourcePath = segment(input.sourceId);
    const capturePath = segment(input.captureId);
    return {
      rawKey: archivePrefix + "raw/" + sourcePath + "/" + capturePath + ".pdf",
      metadataKey:
        archivePrefix + "processed/" + sourcePath + "/" + capturePath + ".metadata.json",
    };
  });
  const matchedScheme = keySchemes.find(
    (scheme) => scheme.rawKey === input.storage.raw.key,
  );
  if (!matchedScheme) {
    throw new Error("The B2 raw-object key does not match the capture being refreshed.");
  }
  const metadataKey = matchedScheme.metadataKey;

  const remoteManifest = {
    ...input.metadata,
    storage: {
      provider: "backblaze-b2-native",
      bucket: context.config.bucketName,
      collection,
      raw: input.storage.raw,
      metadata: { key: metadataKey },
    },
  };
  const metadataBytes = Buffer.from(
    JSON.stringify(remoteManifest, null, 2) + "\n",
    "utf8",
  );
  const digest = sha256(metadataBytes);
  if (
    input.storage.metadata.key === metadataKey &&
    input.storage.metadata.sha256 === digest
  ) {
    return input.storage;
  }

  const metadata = await uploadObject(metadataKey, metadataBytes, "application/json");
  return {
    provider: "backblaze-b2-native",
    bucket: context.config.bucketName,
    collection,
    raw: input.storage.raw,
    metadata,
  };
}
