#!/usr/bin/env python3
from pathlib import Path
import json
import sys
import subprocess

ROOT = Path.cwd()

required = [
    ROOT / "package.json",
    ROOT / "src/api/server.ts",
    ROOT / "src/db/client.ts",
    ROOT / "src/db/migrate.ts",
    ROOT / "db/migrations/001_initial.sql",
    ROOT / "docs/DECISIONS.md",
]

missing = [str(path) for path in required if not path.exists()]
if missing:
    print("Run this from the shasanadesh project root.")
    print("Missing:")
    for item in missing:
        print(f"  {item}")
    sys.exit(1)

(ROOT / "src/workspace").mkdir(
    parents=True,
    exist_ok=True,
)

# ---------------------------------------------------------------------
# Migration 002: users, department assignments, conversations, messages,
# and persistent conversation state.
# ---------------------------------------------------------------------
migration = r'''-- Persistent user/workspace and conversation foundation.
--
-- This schema intentionally separates:
--   1. user profile / working departments
--   2. conversation history
--   3. per-conversation state
--
-- Department preferences are NOT authorization. Future production auth/access
-- control must be enforced independently.

CREATE TABLE IF NOT EXISTS departments (
  id BIGSERIAL PRIMARY KEY,
  canonical_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bootstrap currently-known departments from the document corpus.
INSERT INTO departments (canonical_name)
SELECT DISTINCT TRIM(department)
FROM documents
WHERE department IS NOT NULL
  AND TRIM(department) <> ''
ON CONFLICT (canonical_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS workspace_users (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL,
  designation TEXT,
  preferred_language TEXT NOT NULL DEFAULT 'en'
    CHECK (preferred_language IN ('en', 'hi')),
  default_scope TEXT NOT NULL DEFAULT 'my_departments'
    CHECK (default_scope IN ('my_departments', 'all_departments')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_departments (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL
    REFERENCES workspace_users(id)
    ON DELETE CASCADE,
  department_id BIGINT NOT NULL
    REFERENCES departments(id)
    ON DELETE RESTRICT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_departments_user_active_idx
  ON user_departments (user_id, valid_to);

CREATE INDEX IF NOT EXISTS user_departments_department_active_idx
  ON user_departments (department_id, valid_to);

CREATE UNIQUE INDEX IF NOT EXISTS user_departments_one_primary_active_idx
  ON user_departments (user_id)
  WHERE is_primary = TRUE
    AND valid_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_departments_unique_active_idx
  ON user_departments (user_id, department_id)
  WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL
    REFERENCES workspace_users(id)
    ON DELETE CASCADE,
  title TEXT NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
  ON conversations (user_id, updated_at DESC)
  WHERE archived = FALSE;

CREATE TABLE IF NOT EXISTS conversation_messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL
    REFERENCES conversations(id)
    ON DELETE CASCADE,
  role TEXT NOT NULL
    CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversation_messages_conversation_idx
  ON conversation_messages (conversation_id, created_at, id);

CREATE TABLE IF NOT EXISTS conversation_state (
  conversation_id UUID PRIMARY KEY
    REFERENCES conversations(id)
    ON DELETE CASCADE,
  active_source_id TEXT,
  active_department TEXT,
  topic_summary TEXT,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
'''

(ROOT / "db/migrations/002_workspace.sql").write_text(
    migration
)

# ---------------------------------------------------------------------
# Replace the prototype migration runner with tracked ordered migrations.
# Existing 001 is idempotent, so an already-initialized local DB can safely
# run it once more before it is recorded.
# ---------------------------------------------------------------------
migrate_ts = r'''/**
 * Ordered migration runner with checksum tracking.
 *
 * Earlier development re-ran an idempotent 001 migration on every invocation.
 * From this point forward, migrations are recorded in schema_migrations so
 * later schema changes can safely be non-idempotent when needed.
 */

import {
  createHash,
} from "node:crypto";
import {
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";

import {
  createPool,
} from "./client.js";

interface MigrationRow {
  name: string;
  checksum: string;
}

async function main():
  Promise<void> {
  const migrationsDir =
    path.resolve(
      "db/migrations",
    );

  const names =
    (
      await readdir(
        migrationsDir,
      )
    )
      .filter(
        (name) =>
          /^\d+.*\.sql$/.test(
            name,
          ),
      )
      .sort();

  if (
    names.length === 0
  ) {
    throw new Error(
      "No SQL migrations found.",
    );
  }

  const pool =
    createPool();

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (
      const name of names
    ) {
      const filePath =
        path.join(
          migrationsDir,
          name,
        );

      const sql =
        await readFile(
          filePath,
          "utf8",
        );

      const checksum =
        createHash(
          "sha256",
        )
          .update(sql)
          .digest("hex");

      const existing =
        await pool.query<MigrationRow>(
          `
            SELECT
              name,
              checksum
            FROM schema_migrations
            WHERE name = $1
          `,
          [name],
        );

      if (
        existing.rowCount &&
        existing.rows[0]
      ) {
        if (
          existing.rows[0]
            .checksum !==
          checksum
        ) {
          throw new Error(
            `Migration ${name} was already applied with a different checksum.`,
          );
        }

        console.log(
          `Already applied: ${name}`,
        );

        continue;
      }

      const client =
        await pool.connect();

      try {
        await client.query(
          "BEGIN",
        );

        await client.query(
          sql,
        );

        await client.query(
          `
            INSERT INTO schema_migrations (
              name,
              checksum
            )
            VALUES ($1, $2)
          `,
          [
            name,
            checksum,
          ],
        );

        await client.query(
          "COMMIT",
        );

        console.log(
          `Applied: ${name}`,
        );
      } catch (error) {
        await client.query(
          "ROLLBACK",
        );

        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch(
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
'''

(ROOT / "src/db/migrate.ts").write_text(
    migrate_ts
)

# ---------------------------------------------------------------------
# Workspace model utilities.
# ---------------------------------------------------------------------
model_ts = r'''export type PreferredLanguage =
  | "en"
  | "hi";

export type DefaultScope =
  | "my_departments"
  | "all_departments";

export interface WorkspaceProfileInput {
  displayName: string;
  designation?: string;
  preferredLanguage:
    PreferredLanguage;
  defaultScope:
    DefaultScope;
  primaryDepartment:
    string;
  additionalDepartments?:
    string[];
}

export function normalizeDepartmentNames(
  primaryDepartment: string,
  additionalDepartments:
    string[] = [],
): {
  primaryDepartment: string;
  departments: string[];
} {
  const primary =
    primaryDepartment
      .trim();

  if (!primary) {
    throw new Error(
      "Primary department is required.",
    );
  }

  const seen =
    new Set<string>();

  const departments:
    string[] = [];

  for (
    const candidate of [
      primary,
      ...additionalDepartments,
    ]
  ) {
    const normalized =
      candidate.trim();

    if (!normalized) {
      continue;
    }

    const key =
      normalized.toLocaleLowerCase(
        "en",
      );

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    departments.push(
      normalized,
    );
  }

  return {
    primaryDepartment:
      primary,
    departments,
  };
}

export function defaultConversationTitle(
  firstQuestion: string,
): string {
  const normalized =
    firstQuestion
      .replace(/\s+/g, " ")
      .trim();

  if (!normalized) {
    return "New conversation";
  }

  const maxChars = 72;

  return normalized.length <=
    maxChars
    ? normalized
    : `${normalized
        .slice(
          0,
          maxChars - 1,
        )
        .trimEnd()}…`;
}
'''

(ROOT / "src/workspace/model.ts").write_text(
    model_ts
)

model_test_ts = r'''import assert from "node:assert/strict";

import {
  defaultConversationTitle,
  normalizeDepartmentNames,
} from "./model.js";

{
  const result =
    normalizeDepartmentNames(
      "Medical and Health",
      [
        "AYUSH",
        "Medical and Health",
        " ayush ",
      ],
    );

  assert.equal(
    result.primaryDepartment,
    "Medical and Health",
  );

  assert.deepEqual(
    result.departments,
    [
      "Medical and Health",
      "AYUSH",
    ],
  );
}

assert.equal(
  defaultConversationTitle(
    "  Medical   officer seniority  ",
  ),
  "Medical officer seniority",
);

assert.equal(
  defaultConversationTitle(
    "",
  ),
  "New conversation",
);

console.log(
  "workspace-model tests passed",
);
'''

(ROOT / "src/workspace/model.test.ts").write_text(
    model_test_ts
)

# ---------------------------------------------------------------------
# PostgreSQL store.
# ---------------------------------------------------------------------
store_ts = r'''/**
 * Persistent workspace/conversation store.
 *
 * This module stores user working preferences and chat history. It is NOT an
 * authentication or authorization layer. Production access control must be
 * added separately.
 */

import {
  randomUUID,
} from "node:crypto";
import type {
  Pool,
  PoolClient,
} from "pg";

import {
  createPool,
} from "../db/client.js";
import {
  normalizeDepartmentNames,
  type WorkspaceProfileInput,
} from "./model.js";

const pool: Pool =
  createPool();

export interface WorkspaceProfile {
  id: string;
  displayName: string;
  designation: string | null;
  preferredLanguage:
    "en" | "hi";
  defaultScope:
    | "my_departments"
    | "all_departments";
  primaryDepartment:
    string | null;
  departments: string[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  role:
    | "user"
    | "assistant";
  content: string;
  sources: unknown[];
  metadata:
    Record<string, unknown>;
  createdAt: string;
}

export interface ConversationState {
  activeSourceId:
    string | null;
  activeDepartment:
    string | null;
  topicSummary:
    string | null;
  state:
    Record<string, unknown>;
  updatedAt:
    string | null;
}

async function ensureDepartment(
  client: PoolClient,
  name: string,
): Promise<number> {
  const result =
    await client.query<{
      id: string;
    }>(
      `
        INSERT INTO departments (
          canonical_name
        )
        VALUES ($1)
        ON CONFLICT (canonical_name)
        DO UPDATE SET
          canonical_name =
            EXCLUDED.canonical_name
        RETURNING id
      `,
      [name],
    );

  return Number(
    result.rows[0].id,
  );
}

async function assertConversationOwner(
  userId: string,
  conversationId: string,
): Promise<void> {
  const result =
    await pool.query(
      `
        SELECT 1
        FROM conversations
        WHERE id = $1
          AND user_id = $2
      `,
      [
        conversationId,
        userId,
      ],
    );

  if (!result.rowCount) {
    const error =
      new Error(
        "Conversation not found.",
      );

    (
      error as Error & {
        statusCode?: number;
      }
    ).statusCode = 404;

    throw error;
  }
}

export async function listDepartments():
  Promise<string[]> {
  await pool.query(`
    INSERT INTO departments (
      canonical_name
    )
    SELECT DISTINCT
      TRIM(department)
    FROM documents
    WHERE department IS NOT NULL
      AND TRIM(department) <> ''
    ON CONFLICT (canonical_name)
    DO NOTHING
  `);

  const result =
    await pool.query<{
      canonical_name: string;
    }>(
      `
        SELECT canonical_name
        FROM departments
        ORDER BY canonical_name
      `,
    );

  return result.rows.map(
    (row) =>
      row.canonical_name,
  );
}

export async function createWorkspaceUser(
  input: WorkspaceProfileInput,
): Promise<WorkspaceProfile> {
  const userId =
    randomUUID();

  await saveWorkspaceProfile(
    userId,
    input,
    true,
  );

  return getWorkspaceProfile(
    userId,
  );
}

async function saveWorkspaceProfile(
  userId: string,
  input: WorkspaceProfileInput,
  creating: boolean,
): Promise<void> {
  const displayName =
    input.displayName.trim();

  if (!displayName) {
    throw new Error(
      "Display name is required.",
    );
  }

  const {
    primaryDepartment,
    departments,
  } =
    normalizeDepartmentNames(
      input.primaryDepartment,
      input.additionalDepartments,
    );

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN",
    );

    if (creating) {
      await client.query(
        `
          INSERT INTO workspace_users (
            id,
            display_name,
            designation,
            preferred_language,
            default_scope
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5
          )
        `,
        [
          userId,
          displayName,
          input.designation
            ?.trim() || null,
          input.preferredLanguage,
          input.defaultScope,
        ],
      );
    } else {
      const update =
        await client.query(
          `
            UPDATE workspace_users
            SET
              display_name = $2,
              designation = $3,
              preferred_language = $4,
              default_scope = $5,
              updated_at = NOW()
            WHERE id = $1
          `,
          [
            userId,
            displayName,
            input.designation
              ?.trim() || null,
            input.preferredLanguage,
            input.defaultScope,
          ],
        );

      if (!update.rowCount) {
        const error =
          new Error(
            "Workspace user not found.",
          );

        (
          error as Error & {
            statusCode?: number;
          }
        ).statusCode = 404;

        throw error;
      }

      await client.query(
        `
          UPDATE user_departments
          SET valid_to = NOW()
          WHERE user_id = $1
            AND valid_to IS NULL
        `,
        [userId],
      );
    }

    for (
      const department of
        departments
    ) {
      const departmentId =
        await ensureDepartment(
          client,
          department,
        );

      await client.query(
        `
          INSERT INTO user_departments (
            user_id,
            department_id,
            is_primary
          )
          VALUES (
            $1,
            $2,
            $3
          )
        `,
        [
          userId,
          departmentId,
          department ===
            primaryDepartment,
        ],
      );
    }

    await client.query(
      "COMMIT",
    );
  } catch (error) {
    await client.query(
      "ROLLBACK",
    );

    throw error;
  } finally {
    client.release();
  }
}

export async function updateWorkspaceUser(
  userId: string,
  input: WorkspaceProfileInput,
): Promise<WorkspaceProfile> {
  await saveWorkspaceProfile(
    userId,
    input,
    false,
  );

  return getWorkspaceProfile(
    userId,
  );
}

export async function getWorkspaceProfile(
  userId: string,
): Promise<WorkspaceProfile> {
  const user =
    await pool.query<{
      id: string;
      display_name: string;
      designation:
        string | null;
      preferred_language:
        "en" | "hi";
      default_scope:
        | "my_departments"
        | "all_departments";
    }>(
      `
        SELECT
          id,
          display_name,
          designation,
          preferred_language,
          default_scope
        FROM workspace_users
        WHERE id = $1
      `,
      [userId],
    );

  if (
    !user.rowCount ||
    !user.rows[0]
  ) {
    const error =
      new Error(
        "Workspace user not found.",
      );

    (
      error as Error & {
        statusCode?: number;
      }
    ).statusCode = 404;

    throw error;
  }

  const assignments =
    await pool.query<{
      canonical_name: string;
      is_primary: boolean;
    }>(
      `
        SELECT
          d.canonical_name,
          ud.is_primary
        FROM user_departments ud
        JOIN departments d
          ON d.id =
            ud.department_id
        WHERE ud.user_id = $1
          AND ud.valid_to IS NULL
        ORDER BY
          ud.is_primary DESC,
          d.canonical_name
      `,
      [userId],
    );

  return {
    id:
      user.rows[0].id,
    displayName:
      user.rows[0]
        .display_name,
    designation:
      user.rows[0]
        .designation,
    preferredLanguage:
      user.rows[0]
        .preferred_language,
    defaultScope:
      user.rows[0]
        .default_scope,
    primaryDepartment:
      assignments.rows.find(
        (row) =>
          row.is_primary,
      )?.canonical_name ??
      null,
    departments:
      assignments.rows.map(
        (row) =>
          row.canonical_name,
      ),
  };
}

export async function createConversation(
  userId: string,
  title: string,
): Promise<ConversationSummary> {
  await getWorkspaceProfile(
    userId,
  );

  const id =
    randomUUID();

  const normalizedTitle =
    title.trim() ||
    "New conversation";

  const result =
    await pool.query<{
      id: string;
      title: string;
      archived: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        INSERT INTO conversations (
          id,
          user_id,
          title
        )
        VALUES (
          $1,
          $2,
          $3
        )
        RETURNING
          id,
          title,
          archived,
          created_at,
          updated_at
      `,
      [
        id,
        userId,
        normalizedTitle,
      ],
    );

  const row =
    result.rows[0];

  return {
    id: row.id,
    title:
      row.title,
    archived:
      row.archived,
    createdAt:
      row.created_at
        .toISOString(),
    updatedAt:
      row.updated_at
        .toISOString(),
  };
}

export async function listConversations(
  userId: string,
): Promise<ConversationSummary[]> {
  await getWorkspaceProfile(
    userId,
  );

  const result =
    await pool.query<{
      id: string;
      title: string;
      archived: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        SELECT
          id,
          title,
          archived,
          created_at,
          updated_at
        FROM conversations
        WHERE user_id = $1
          AND archived = FALSE
        ORDER BY
          updated_at DESC
      `,
      [userId],
    );

  return result.rows.map(
    (row) => ({
      id: row.id,
      title: row.title,
      archived:
        row.archived,
      createdAt:
        row.created_at
          .toISOString(),
      updatedAt:
        row.updated_at
          .toISOString(),
    }),
  );
}

export async function addConversationMessage(
  userId: string,
  conversationId: string,
  input: {
    role:
      | "user"
      | "assistant";
    content: string;
    sources?: unknown[];
    metadata?:
      Record<string, unknown>;
  },
): Promise<ConversationMessage> {
  await assertConversationOwner(
    userId,
    conversationId,
  );

  const content =
    input.content.trim();

  if (!content) {
    throw new Error(
      "Message content is required.",
    );
  }

  const id =
    randomUUID();

  const result =
    await pool.query<{
      id: string;
      role:
        | "user"
        | "assistant";
      content: string;
      sources: unknown[];
      metadata:
        Record<string, unknown>;
      created_at: Date;
    }>(
      `
        INSERT INTO conversation_messages (
          id,
          conversation_id,
          role,
          content,
          sources,
          metadata
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5::jsonb,
          $6::jsonb
        )
        RETURNING
          id,
          role,
          content,
          sources,
          metadata,
          created_at
      `,
      [
        id,
        conversationId,
        input.role,
        content,
        JSON.stringify(
          input.sources ?? [],
        ),
        JSON.stringify(
          input.metadata ?? {},
        ),
      ],
    );

  await pool.query(
    `
      UPDATE conversations
      SET updated_at = NOW()
      WHERE id = $1
    `,
    [conversationId],
  );

  const row =
    result.rows[0];

  return {
    id: row.id,
    role:
      row.role,
    content:
      row.content,
    sources:
      row.sources,
    metadata:
      row.metadata,
    createdAt:
      row.created_at
        .toISOString(),
  };
}

export async function saveConversationState(
  userId: string,
  conversationId: string,
  state: {
    activeSourceId?:
      string | null;
    activeDepartment?:
      string | null;
    topicSummary?:
      string | null;
    state?:
      Record<string, unknown>;
  },
): Promise<void> {
  await assertConversationOwner(
    userId,
    conversationId,
  );

  await pool.query(
    `
      INSERT INTO conversation_state (
        conversation_id,
        active_source_id,
        active_department,
        topic_summary,
        state,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::jsonb,
        NOW()
      )
      ON CONFLICT (
        conversation_id
      )
      DO UPDATE SET
        active_source_id =
          EXCLUDED.active_source_id,
        active_department =
          EXCLUDED.active_department,
        topic_summary =
          EXCLUDED.topic_summary,
        state =
          EXCLUDED.state,
        updated_at =
          NOW()
    `,
    [
      conversationId,
      state.activeSourceId ??
        null,
      state.activeDepartment ??
        null,
      state.topicSummary ??
        null,
      JSON.stringify(
        state.state ?? {},
      ),
    ],
  );

  await pool.query(
    `
      UPDATE conversations
      SET updated_at = NOW()
      WHERE id = $1
    `,
    [conversationId],
  );
}

export async function getConversation(
  userId: string,
  conversationId: string,
): Promise<{
  conversation:
    ConversationSummary;
  messages:
    ConversationMessage[];
  state:
    ConversationState;
}> {
  await assertConversationOwner(
    userId,
    conversationId,
  );

  const conversation =
    await pool.query<{
      id: string;
      title: string;
      archived: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        SELECT
          id,
          title,
          archived,
          created_at,
          updated_at
        FROM conversations
        WHERE id = $1
          AND user_id = $2
      `,
      [
        conversationId,
        userId,
      ],
    );

  const messages =
    await pool.query<{
      id: string;
      role:
        | "user"
        | "assistant";
      content: string;
      sources: unknown[];
      metadata:
        Record<string, unknown>;
      created_at: Date;
    }>(
      `
        SELECT
          id,
          role,
          content,
          sources,
          metadata,
          created_at
        FROM conversation_messages
        WHERE conversation_id = $1
        ORDER BY
          created_at,
          id
      `,
      [conversationId],
    );

  const states =
    await pool.query<{
      active_source_id:
        string | null;
      active_department:
        string | null;
      topic_summary:
        string | null;
      state:
        Record<string, unknown>;
      updated_at: Date;
    }>(
      `
        SELECT
          active_source_id,
          active_department,
          topic_summary,
          state,
          updated_at
        FROM conversation_state
        WHERE conversation_id = $1
      `,
      [conversationId],
    );

  const conversationRow =
    conversation.rows[0];

  const stateRow =
    states.rows[0];

  return {
    conversation: {
      id:
        conversationRow.id,
      title:
        conversationRow.title,
      archived:
        conversationRow.archived,
      createdAt:
        conversationRow
          .created_at
          .toISOString(),
      updatedAt:
        conversationRow
          .updated_at
          .toISOString(),
    },
    messages:
      messages.rows.map(
        (row) => ({
          id: row.id,
          role:
            row.role,
          content:
            row.content,
          sources:
            row.sources,
          metadata:
            row.metadata,
          createdAt:
            row.created_at
              .toISOString(),
        }),
      ),
    state:
      stateRow
        ? {
            activeSourceId:
              stateRow
                .active_source_id,
            activeDepartment:
              stateRow
                .active_department,
            topicSummary:
              stateRow
                .topic_summary,
            state:
              stateRow.state,
            updatedAt:
              stateRow
                .updated_at
                .toISOString(),
          }
        : {
            activeSourceId:
              null,
            activeDepartment:
              null,
            topicSummary:
              null,
            state: {},
            updatedAt:
              null,
          },
  };
}
'''

(ROOT / "src/workspace/store.ts").write_text(
    store_ts
)

# ---------------------------------------------------------------------
# Fastify routes kept separate from the core RAG route file.
# ---------------------------------------------------------------------
routes_ts = r'''/**
 * Workspace/profile/history routes.
 *
 * These routes are persistence APIs for the development product shell.
 * They do not provide authentication. The caller-supplied user ID is only an
 * ownership key until a real identity provider is integrated.
 */

import type {
  FastifyInstance,
  FastifyReply,
} from "fastify";
import {
  z,
} from "zod";

import {
  defaultConversationTitle,
} from "./model.js";
import {
  addConversationMessage,
  createConversation,
  createWorkspaceUser,
  getConversation,
  getWorkspaceProfile,
  listConversations,
  listDepartments,
  saveConversationState,
  updateWorkspaceUser,
} from "./store.js";

const ProfileBodySchema =
  z.object({
    displayName:
      z.string()
        .trim()
        .min(1)
        .max(200),
    designation:
      z.string()
        .trim()
        .max(200)
        .optional(),
    preferredLanguage:
      z.enum([
        "en",
        "hi",
      ]),
    defaultScope:
      z.enum([
        "my_departments",
        "all_departments",
      ]),
    primaryDepartment:
      z.string()
        .trim()
        .min(1)
        .max(200),
    additionalDepartments:
      z.array(
        z.string()
          .trim()
          .min(1)
          .max(200),
      )
        .max(12)
        .optional(),
  });

const CreateConversationSchema =
  z.object({
    title:
      z.string()
        .trim()
        .max(200)
        .optional(),
    firstQuestion:
      z.string()
        .trim()
        .max(5000)
        .optional(),
  });

const MessageSchema =
  z.object({
    role:
      z.enum([
        "user",
        "assistant",
      ]),
    content:
      z.string()
        .trim()
        .min(1),
    sources:
      z.array(
        z.unknown(),
      )
        .optional(),
    metadata:
      z.record(
        z.string(),
        z.unknown(),
      )
        .optional(),
  });

const StateSchema =
  z.object({
    activeSourceId:
      z.string()
        .trim()
        .max(200)
        .nullable()
        .optional(),
    activeDepartment:
      z.string()
        .trim()
        .max(200)
        .nullable()
        .optional(),
    topicSummary:
      z.string()
        .trim()
        .max(2000)
        .nullable()
        .optional(),
    state:
      z.record(
        z.string(),
        z.unknown(),
      )
        .optional(),
  });

function sendError(
  reply: FastifyReply,
  error: unknown,
) {
  const statusCode =
    (
      error as {
        statusCode?: unknown;
      }
    )?.statusCode;

  const status =
    typeof statusCode ===
      "number"
      ? statusCode
      : 500;

  return reply
    .code(status)
    .send({
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });
}

export function registerWorkspaceRoutes(
  server: FastifyInstance,
): void {
  server.get(
    "/api/workspace/departments",
    async (
      _request,
      reply,
    ) => {
      try {
        return {
          departments:
            await listDepartments(),
        };
      } catch (error) {
        return sendError(
          reply,
          error,
        );
      }
    },
  );

  server.post(
    "/api/workspace/users",
    async (
      request,
      reply,
    ) => {
      const parsed =
        ProfileBodySchema.safeParse(
          request.body,
        );

      if (!parsed.success) {
        return reply
          .code(400)
          .send({
            error:
              parsed.error
                .flatten(),
          });
      }

      try {
        return await createWorkspaceUser(
          parsed.data,
        );
      } catch (error) {
        return sendError(
          reply,
          error,
        );
      }
    },
  );

  server.get<{
    Params: {
      userId: string;
    };
  }>(
    "/api/workspace/users/:userId",
    async (
      request,
      reply,
    ) => {
      try {
        return await getWorkspaceProfile(
          request.params
            .userId,
        );
      } catch (error) {
        return sendError(
          reply,
          error,
        );
      }
    },
  );

  server.put<{
    Params: {
      userId: string;
    };
  }>(
    "/api/workspace/users/:userId",
    async (
      request,
      reply,
    ) => {
      const parsed =
        ProfileBodySchema.safeParse(
          request.body,
        );

      if (!parsed.success) {
        return reply
          .code(400)
          .send({
            error:
              parsed.error
                .flatten(),
          });
      }

      try {
        return await updateWorkspaceUser(
          request.params
            .userId,
          parsed.data,
        );
      } catch (error) {
        return sendError(
          reply,
          error,
        );
      }
    },
  );

  server.get<{
    Params: {
      userId: string;
    };
  }>(
    "/api/workspace/users/:userId/conversations",
    async (
      request,
      reply,
    ) => {
      try {
        return {
          conversations:
            await listConversations(
              request.params
                .userId,
            ),
        };
      } catch (error) {
        return sendError(
          reply,
          error,
        );
      }
    },
  );

  server.post<{
    Params: {
      userId: string;
    };
  }>(
    "/api/workspace/users/:userId/conversations",
    async (
      request,
      reply,
    ) => {
      const parsed =
        CreateConversationSchema
          .safeParse(
            request.body,
          );

      if (!parsed.success) {
        return reply
          .code(400)
          .send({
            error:
              parsed.error
                .flatten(),
          });
      }

      const title =
        parsed.data.title ??
        defaultConversationTitle(
          parsed.data
            .firstQuestion ??
            "",
        );

      try {
        return await createConversation(
          request.params
            .userId,
          title,
        );
      } catch (error) {
        return sendError(
          reply,
          error,
        );
      }
    },
  );

  server.get<{
    Params: {
      userId: string;
      conversationId:
        string;
    };
  }>(
    "/api/workspace/users/:userId/conversations/:conversationId",
    async (
      request,
      reply,
    ) => {
      try {
        return await getConversation(
          request.params
            .userId,
          request.params
            .conversationId,
        );
      } catch (error) {
        return sendError(
          reply,
          error,
        );
      }
    },
  );

  server.post<{
    Params: {
      userId: string;
      conversationId:
        string;
    };
  }>(
    "/api/workspace/users/:userId/conversations/:conversationId/messages",
    async (
      request,
      reply,
    ) => {
      const parsed =
        MessageSchema.safeParse(
          request.body,
        );

      if (!parsed.success) {
        return reply
          .code(400)
          .send({
            error:
              parsed.error
                .flatten(),
          });
      }

      try {
        return await addConversationMessage(
          request.params
            .userId,
          request.params
            .conversationId,
          parsed.data,
        );
      } catch (error) {
        return sendError(
          reply,
          error,
        );
      }
    },
  );

  server.put<{
    Params: {
      userId: string;
      conversationId:
        string;
    };
  }>(
    "/api/workspace/users/:userId/conversations/:conversationId/state",
    async (
      request,
      reply,
    ) => {
      const parsed =
        StateSchema.safeParse(
          request.body,
        );

      if (!parsed.success) {
        return reply
          .code(400)
          .send({
            error:
              parsed.error
                .flatten(),
          });
      }

      try {
        await saveConversationState(
          request.params
            .userId,
          request.params
            .conversationId,
          parsed.data,
        );

        return {
          ok: true,
        };
      } catch (error) {
        return sendError(
          reply,
          error,
        );
      }
    },
  );
}
'''

(ROOT / "src/workspace/routes.ts").write_text(
    routes_ts
)

# ---------------------------------------------------------------------
# Patch the existing API server with one import + one route registration.
# ---------------------------------------------------------------------
server_path = ROOT / "src/api/server.ts"
server = server_path.read_text()

if 'from "../workspace/routes.js";' not in server:
    import_marker = '''import {
  z,
} from "zod";
'''

    if import_marker not in server:
        # Current server normally uses one-line zod import; support it too.
        import_marker = '''import { z } from "zod";
'''

    if import_marker not in server:
        raise SystemExit(
            "Could not locate zod import in src/api/server.ts."
        )

    server = server.replace(
        import_marker,
        import_marker
        + '''import {
  registerWorkspaceRoutes,
} from "../workspace/routes.js";
''',
        1,
    )

if "registerWorkspaceRoutes(server);" not in server:
    cors_marker = '''server.register(cors, {
  origin: true,
});
'''

    if cors_marker not in server:
        raise SystemExit(
            "Could not locate CORS registration in src/api/server.ts."
        )

    server = server.replace(
        cors_marker,
        cors_marker
        + '''
registerWorkspaceRoutes(server);
''',
        1,
    )

server_path.write_text(server)

# ---------------------------------------------------------------------
# Package scripts.
# ---------------------------------------------------------------------
package_path = ROOT / "package.json"
package = json.loads(
    package_path.read_text()
)

scripts = package.setdefault(
    "scripts",
    {},
)

scripts[
    "test:workspace-model"
] = "tsx src/workspace/model.test.ts"

package_path.write_text(
    json.dumps(
        package,
        indent=2,
    )
    + "\n"
)

# ---------------------------------------------------------------------
# Docs.
# ---------------------------------------------------------------------
workspace_doc = r'''# User Workspace and Conversation Persistence

## Purpose

The product needs three independent layers:

1. **Authorization** — what a real user is allowed to access.
2. **Working scope** — which departments the user normally works with.
3. **Conversation context** — what the current thread is about.

This implementation adds persistence for layers 2 and 3. It does **not** implement
authentication or authorization yet.

## User profile

A workspace profile stores:

- display name
- designation
- preferred response language
- default search scope
- primary department
- additional working departments

Department assignments are temporal. Updating a profile closes the previous active
assignments instead of deleting them, allowing future posting/transfer history.

## Conversation history

Each conversation stores:

- title
- ordered user/assistant messages
- source cards attached to assistant messages
- arbitrary per-message metadata
- persistent active source/department/topic state

This lets the product reopen a conversation without feeding the entire raw history to the
generator.

## Retrieval precedence

Planned retrieval precedence:

1. explicit department/source requested in the current user question
2. active conversation source/department
3. user's working department scope
4. global corpus

Working scope is a relevance default, not an access-control boundary.

## Development identity

The current APIs accept a caller-supplied workspace user ID. This is sufficient for local
product development only. Before a real deployment, replace this with authenticated
server-side identity and independent authorization rules.
'''

(ROOT / "docs/WORKSPACE.md").write_text(
    workspace_doc
)

decisions_path = ROOT / "docs/DECISIONS.md"
decisions = decisions_path.read_text()

if "ADR-036" not in decisions:
    decisions += r'''

## ADR-036 - Persistent workspace profile and chat history before production authentication

User working departments, preferred language, conversations, messages, and conversation
state are persisted in PostgreSQL.

Working department scope is a retrieval preference, not authorization. Production
identity and document-access authorization remain a separate future layer.

Department assignments are temporal (`valid_from` / `valid_to`) so officer transfers can
be represented without destroying historical context.

Conversation messages may store retrieved source metadata, but generated assistant text
does not become corpus evidence.
'''
    decisions_path.write_text(
        decisions.rstrip() + "\n"
    )

# ---------------------------------------------------------------------
# Validation.
# ---------------------------------------------------------------------
print("Running workspace model tests...")
subprocess.run(
    [
        "npm",
        "run",
        "test:workspace-model",
    ],
    check=True,
)

print()
print("Running root TypeScript check...")
subprocess.run(
    [
        "npx",
        "tsc",
        "--noEmit",
    ],
    check=True,
)

print()
print("Workspace persistence foundation installed.")
print()
print("Next:")
print("  export DATABASE_URL='postgresql://shasanadesh:shasanadesh_dev@localhost:5432/shasanadesh'")
print("  npm run db:migrate")
print("  npm run test:rag-safety")
