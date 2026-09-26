/**
 * Preserve the previous capture before a forced re-download.
 *
 * Originals are immutable evidence (ADR-002/003): Shasanadesh can return
 * different bytes for the same order, so a re-download must not destroy the
 * earlier capture. The previous original.pdf and metadata.json are copied to
 * captures/<capture-id>/ inside the document directory before being replaced.
 */

import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface PreviousCapture {
  captureId: string;
  rawSha256: string;
  downloadedAt: string | null;
  archivedPath: string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the capture history to record in the new metadata (previous
 * entries plus the capture just preserved), or null when there was nothing
 * to preserve.
 */
export async function preservePreviousCapture(
  sourceDir: string,
): Promise<PreviousCapture[] | null> {
  const pdfPath = path.join(sourceDir, "original.pdf");
  const metadataPath = path.join(sourceDir, "metadata.json");

  if (!(await exists(pdfPath)) || !(await exists(metadataPath))) {
    return null;
  }

  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
    capture?: { captureId?: unknown; downloadedAt?: unknown };
    previousCaptures?: PreviousCapture[];
  };
  const pdf = await readFile(pdfPath);
  const rawSha256 = createHash("sha256").update(pdf).digest("hex");

  const recordedId = metadata.capture?.captureId;
  const captureId =
    typeof recordedId === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(recordedId)
      ? recordedId
      : `legacy-${rawSha256.slice(0, 16)}`;

  const archiveDir = path.join(sourceDir, "captures", captureId);
  await mkdir(archiveDir, { recursive: true });
  await copyFile(pdfPath, path.join(archiveDir, "original.pdf"));
  await copyFile(metadataPath, path.join(archiveDir, "metadata.json"));

  return [
    ...(Array.isArray(metadata.previousCaptures) ? metadata.previousCaptures : []),
    {
      captureId,
      rawSha256,
      downloadedAt:
        typeof metadata.capture?.downloadedAt === "string"
          ? metadata.capture.downloadedAt
          : null,
      archivedPath: path.join("captures", captureId),
    },
  ];
}
