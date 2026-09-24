/**
 * Cookie-backed development sessions.
 *
 * Raw session tokens are never stored in PostgreSQL. Only SHA-256 hashes are
 * persisted. The cookie is HttpOnly and contains an opaque random token.
 *
 * This is intentionally a development identity layer. Production deployment
 * should replace dev-login with the selected real identity provider while
 * preserving the session/profile boundary.
 */

import {
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

import {
  createPool,
} from "../db/client.js";
import {
  getWorkspaceProfile,
  type WorkspaceProfile,
} from "./store.js";
import {
  readSessionToken,
} from "./session-cookie.js";

const pool =
  createPool();

const SESSION_TTL_DAYS =
  Number.parseInt(
    process.env
      .SESSION_TTL_DAYS ??
      "30",
    10,
  );

function tokenHash(
  token: string,
): string {
  return createHash(
    "sha256",
  )
    .update(token)
    .digest("hex");
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  profile:
    WorkspaceProfile;
  expiresAt: string;
}

export interface CreatedSession extends
  ResolvedSession {
  token: string;
  maxAgeSeconds: number;
}

export async function createDevelopmentSession(
  userId: string,
): Promise<CreatedSession> {
  const profile =
    await getWorkspaceProfile(
      userId,
    );

  const token =
    randomBytes(32)
      .toString(
        "base64url",
      );

  const id =
    randomUUID();

  const maxAgeSeconds =
    Math.max(
      60,
      SESSION_TTL_DAYS *
        24 *
        60 *
        60,
    );

  const expiresAt =
    new Date(
      Date.now() +
      maxAgeSeconds *
        1000,
    );

  await pool.query(
    `
      INSERT INTO workspace_sessions (
        id,
        user_id,
        token_hash,
        expires_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4
      )
    `,
    [
      id,
      userId,
      tokenHash(
        token,
      ),
      expiresAt,
    ],
  );

  return {
    sessionId:
      id,
    userId,
    profile,
    expiresAt:
      expiresAt
        .toISOString(),
    token,
    maxAgeSeconds,
  };
}

export async function resolveSessionFromCookie(
  cookieHeader:
    string | undefined,
): Promise<ResolvedSession | null> {
  const token =
    readSessionToken(
      cookieHeader,
    );

  if (!token) {
    return null;
  }

  const result =
    await pool.query<{
      id: string;
      user_id: string;
      expires_at: Date;
    }>(
      `
        SELECT
          id,
          user_id,
          expires_at
        FROM workspace_sessions
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > NOW()
        LIMIT 1
      `,
      [
        tokenHash(
          token,
        ),
      ],
    );

  const row =
    result.rows[0];

  if (!row) {
    return null;
  }

  await pool.query(
    `
      UPDATE workspace_sessions
      SET last_seen_at =
        NOW()
      WHERE id = $1
    `,
    [
      row.id,
    ],
  );

  return {
    sessionId:
      row.id,
    userId:
      row.user_id,
    profile:
      await getWorkspaceProfile(
        row.user_id,
      ),
    expiresAt:
      row.expires_at
        .toISOString(),
  };
}

export async function revokeSessionFromCookie(
  cookieHeader:
    string | undefined,
): Promise<void> {
  const token =
    readSessionToken(
      cookieHeader,
    );

  if (!token) {
    return;
  }

  await pool.query(
    `
      UPDATE workspace_sessions
      SET revoked_at =
        NOW()
      WHERE token_hash = $1
        AND revoked_at IS NULL
    `,
    [
      tokenHash(
        token,
      ),
    ],
  );
}

export async function listDevelopmentProfiles():
  Promise<WorkspaceProfile[]> {
  const result =
    await pool.query<{
      id: string;
    }>(
      `
        SELECT id
        FROM workspace_users
        ORDER BY
          updated_at DESC,
          created_at DESC
        LIMIT 50
      `,
    );

  const profiles:
    WorkspaceProfile[] = [];

  for (
    const row of result.rows
  ) {
    try {
      profiles.push(
        await getWorkspaceProfile(
          row.id,
        ),
      );
    } catch {
      // Skip malformed development rows rather than breaking the selector.
    }
  }

  return profiles;
}
