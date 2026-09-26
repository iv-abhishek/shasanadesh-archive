import { writeFile } from "node:fs/promises";
import {
  isB2Enabled,
  refreshCaptureManifestInB2,
  type B2CaptureStorage,
} from "./b2.js";

interface CapturedMetadata {
  sourceId: string;
  capture?: { captureId?: string };
  storage?: B2CaptureStorage;
  storageManifestSyncPending?: boolean;
  [key: string]: unknown;
}

export async function saveDocumentMetadata(
  metadataPath: string,
  metadata: CapturedMetadata,
): Promise<void> {
  const writeLocal = () =>
    writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");

  const storage = metadata.storage;
  const captureId = metadata.capture?.captureId;
  await writeLocal();

  if (!storage || storage.provider !== "backblaze-b2-native" || !captureId) {
    return;
  }

  try {
    if (!isB2Enabled()) {
      delete metadata.storageManifestSyncPending;
      await writeLocal();
      return;
    }

    metadata.storageManifestSyncPending = true;
    await writeLocal();
    delete metadata.storageManifestSyncPending;

    metadata.storage = await refreshCaptureManifestInB2({
      sourceId: metadata.sourceId,
      captureId,
      metadata,
      storage,
    });
    delete metadata.storageManifestSyncPending;
    await writeLocal();
  } catch (error) {
    metadata.storageManifestSyncPending = true;
    await writeLocal();
    throw error;
  }
}
