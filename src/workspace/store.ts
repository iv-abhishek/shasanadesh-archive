/**
 * Persistent workspace/conversation store.
 *
 * This module stores user working preferences and chat history. It is NOT an
 * authentication or authorization layer. Production access control must be
 * added separately.
 */

import { profilePlace } from "../places/lgd.js";
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
  MAX_WORKSPACE_PROFILES,
  normalizeDepartmentNames,
  type WorkspaceProfileInput,
} from "./model.js";

const pool: Pool =
  createPool();

/** For one-shot scripts (chats:archive) that must exit when done. */
export async function closeWorkspacePool(): Promise<void> {
  await pool.end();
}

export interface WorkspaceProfile {
  id: string;
  displayName: string;
  designation: string | null;
  stateName: string | null;
  district: string | null;
  contactNumber: string | null;
  preferredLanguage:
    "en" | "hi";
  defaultScope:
    | "my_departments"
    | "all_departments";
  primaryDepartment:
    string | null;
  departments: string[];
  /** Departments held as additional charge (subset of departments). */
  additionalChargeDepartments: string[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  archived: boolean;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
  /** ADR-066: when and why it was archived ("inactive" = automatic). */
  archivedAt?: string | null;
  archivedReason?: "manual" | "inactive" | null;
}

export interface MessageFeedback {
  rating: "up" | "down";
  reason: string | null;
  comment: string | null;
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
  feedback?: MessageFeedback | null;
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

/**
 * One choosable name per department for the profile picker (ADR-044/047).
 *
 * Documents name a department in English ("Public Works") or Hindi
 * ("लोक निर्माण विभाग", often with zero-width joiners). Shasanadesh orders of
 * one department share a department_id, so names are grouped by that ID and
 * the English name is preferred, else the most common spelling. Retrieval
 * widens any chosen name back to all spellings by department_id, so either
 * spelling scopes correctly. Names already on a profile are always listed so a
 * current selection never disappears from the picker.
 */
export const DEPARTMENT_CHOICES_SQL = `
  WITH names AS (
    SELECT
      CASE
        WHEN d.department_id IS NOT NULL
          AND d.source_id ~ '^[0-9]+#[0-9]+#[0-9]+#[0-9]{4}$'
          THEN 'id:' || d.department_id
        ELSE 'name:' || translate(TRIM(d.department), $1, '')
      END AS department_key,
      regexp_replace(translate(TRIM(d.department), $1, ''), '\\s+', ' ', 'g') AS name,
      COUNT(*) AS documents
    FROM documents d
    WHERE NULLIF(TRIM(d.department), '') IS NOT NULL
    GROUP BY 1, 2
  ),
  ranked AS (
    SELECT
      name,
      ROW_NUMBER() OVER (
        PARTITION BY department_key
        ORDER BY (name ~ '[A-Za-z]') DESC, documents DESC, name
      ) AS choice
    FROM names
  )
  SELECT name FROM ranked WHERE choice = 1
  UNION
  SELECT dep.canonical_name AS name
  FROM user_departments ud
  JOIN departments dep ON dep.id = ud.department_id
  WHERE ud.valid_to IS NULL
  ORDER BY name
`;

export async function listDepartments():
  Promise<string[]> {
  const result = await pool.query<{ name: string }>(
    DEPARTMENT_CHOICES_SQL,
    ["\u200c\u200d"],
  );
  const names = result.rows.map((row) => row.name);

  // Profiles reference departments by row; make sure every choice has one.
  if (names.length) {
    await pool.query(
      `
        INSERT INTO departments (canonical_name)
        SELECT unnest($1::text[])
        ON CONFLICT (canonical_name) DO NOTHING
      `,
      [names],
    );
  }

  return names;
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

// Migration 013 adds the LGD code columns; until it has run, profiles save
// without them (names only) instead of failing.
let lgdColumns: Promise<boolean> | null = null;
function hasLgdColumns(): Promise<boolean> {
  lgdColumns ??= pool
    .query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'workspace_users' AND column_name IN ('state_lgd_code', 'district_lgd_code')`,
    )
    .then((result) => result.rows[0]?.n === 2)
    .catch(() => false);
  return lgdColumns.then((ok) => {
    if (!ok) lgdColumns = null; // check again next time (after npm run db:migrate)
    return ok;
  });
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
    additionalCharge,
  } =
    normalizeDepartmentNames(
      input.primaryDepartment,
      input.additionalDepartments,
      input.additionalChargeDepartments,
    );

  // State and district as LGD names + codes when LGD lists them.
  const place = profilePlace(input.stateName, input.district);
  const withCodes = await hasLgdColumns();

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN",
    );

    if (creating) {
      // Profile cap: serialise creations, then count (no race past the limit).
      await client.query("SELECT pg_advisory_xact_lock(hashtext('workspace_users:create'))");
      const existing = await client.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM workspace_users");
      if ((existing.rows[0]?.n ?? 0) >= MAX_WORKSPACE_PROFILES) {
        const error = new Error(
          `All ${MAX_WORKSPACE_PROFILES} profile slots are in use. Use an existing profile instead.`,
        ) as Error & { statusCode?: number };
        error.statusCode = 409;
        throw error;
      }
      await client.query(
        `
          INSERT INTO workspace_users (
            id,
            display_name,
            designation,
            state_name,
            district,
            contact_number,
            preferred_language,
            default_scope
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8
          )
        `,
        [
          userId,
          displayName,
          input.designation
            ?.trim() || null,
          place.stateName,
          place.district,
          input.contactNumber
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
              state_name = $4,
              district = $5,
              contact_number = $6,
              preferred_language = $7,
              default_scope = $8,
              updated_at = NOW()
            WHERE id = $1
          `,
          [
            userId,
            displayName,
            input.designation
              ?.trim() || null,
            place.stateName,
            place.district,
            input.contactNumber
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
            is_primary,
            additional_charge
          )
          VALUES (
            $1,
            $2,
            $3,
            $4
          )
        `,
        [
          userId,
          departmentId,
          department ===
            primaryDepartment,
          additionalCharge.includes(
            department,
          ),
        ],
      );
    }

    if (withCodes) {
      await client.query(
        `UPDATE workspace_users SET state_lgd_code = $2, district_lgd_code = $3 WHERE id = $1`,
        [userId, place.stateCode, place.districtCode],
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
      state_name: string | null;
      district: string | null;
      contact_number: string | null;
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
          state_name,
          district,
          contact_number,
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
      additional_charge: boolean;
    }>(
      `
        SELECT
          d.canonical_name,
          ud.is_primary,
          ud.additional_charge
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
    stateName:
      user.rows[0]
        .state_name,
    district:
      user.rows[0]
        .district,
    contactNumber:
      user.rows[0]
        .contact_number,
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
    additionalChargeDepartments:
      assignments.rows
        .filter(
          (row) =>
            row.additional_charge,
        )
        .map(
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
      is_pinned: boolean;
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
          is_pinned,
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
    isPinned:
      row.is_pinned,
    createdAt:
      row.created_at
        .toISOString(),
    updatedAt:
      row.updated_at
        .toISOString(),
  };
}

export async function updateConversation(
  userId: string,
  conversationId: string,
  input: {
    title?: string;
    isPinned?: boolean;
    archived?: boolean;
  },
): Promise<ConversationSummary> {
  const result =
    await pool.query<{
      id: string;
      title: string;
      archived: boolean;
      is_pinned: boolean;
      created_at: Date;
      updated_at: Date;
      archived_at: Date | null;
      archived_reason: "manual" | "inactive" | null;
    }>(
      `
        UPDATE conversations
        SET title = COALESCE($3, title),
            is_pinned = COALESCE($4, is_pinned),
            archived = COALESCE($5, archived),
            -- ADR-066: record manual archive; a restore counts as activity.
            archived_at = CASE
              WHEN $5::boolean IS TRUE AND archived = FALSE THEN NOW()
              WHEN $5::boolean IS FALSE THEN NULL
              ELSE archived_at
            END,
            archived_reason = CASE
              WHEN $5::boolean IS TRUE AND archived = FALSE THEN 'manual'
              WHEN $5::boolean IS FALSE THEN NULL
              ELSE archived_reason
            END,
            restored_at = CASE
              WHEN $5::boolean IS FALSE AND archived = TRUE THEN NOW()
              ELSE restored_at
            END,
            updated_at = CASE
              WHEN $3::text IS NOT NULL THEN NOW()
              ELSE updated_at
            END
        WHERE id = $1
          AND user_id = $2
        RETURNING
          id,
          title,
          archived,
          is_pinned,
          created_at,
          updated_at,
          archived_at,
          archived_reason
      `,
      [
        conversationId,
        userId,
        input.title ?? null,
        input.isPinned ?? null,
        input.archived ?? null,
      ],
    );

  const row = result.rows[0];

  if (!row) {
    const error =
      new Error("Conversation not found.");
    (
      error as Error & {
        statusCode?: number;
      }
    ).statusCode = 404;
    throw error;
  }

  return {
    id: row.id,
    title: row.title,
    archived: row.archived,
    isPinned: row.is_pinned,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived && row.archived_at ? row.archived_at.toISOString() : null,
    archivedReason: row.archived ? row.archived_reason ?? null : null,
  };
}

export async function deleteConversation(
  userId: string,
  conversationId: string,
): Promise<void> {
  const result =
    await pool.query(
      `
        DELETE FROM conversations
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
      new Error("Conversation not found.");
    (
      error as Error & {
        statusCode?: number;
      }
    ).statusCode = 404;
    throw error;
  }
}

/**
 * ADR-066: conversations with no activity for WORKSPACE_ARCHIVE_AFTER_DAYS
 * (default 30; 0 turns it off) move to Archives. Activity is the last message
 * or rename (updated_at) or the last restore. Pinned conversations stay.
 */
export const ARCHIVE_AFTER_DAYS = (() => {
  const value = Number.parseInt(process.env.WORKSPACE_ARCHIVE_AFTER_DAYS ?? "30", 10);
  return Number.isFinite(value) && value >= 0 ? value : 30;
})();

export const AUTO_ARCHIVE_SQL = `
  UPDATE conversations
  SET archived = TRUE,
      archived_at = NOW(),
      archived_reason = 'inactive'
  WHERE archived = FALSE
    AND is_pinned = FALSE
    AND ($1::uuid IS NULL OR user_id = $1::uuid)
    AND GREATEST(updated_at, COALESCE(restored_at, updated_at))
        < NOW() - make_interval(days => $2::int)
`;

/** Archive inactive conversations of one user (or everyone when userId is null). */
export async function archiveInactiveConversations(
  userId: string | null,
  days = ARCHIVE_AFTER_DAYS,
): Promise<number> {
  if (days <= 0) return 0;
  const result = await pool.query(AUTO_ARCHIVE_SQL, [userId, days]);
  return result.rowCount ?? 0;
}

export async function listConversations(
  userId: string,
  archived = false,
): Promise<ConversationSummary[]> {
  await getWorkspaceProfile(
    userId,
  );

  // Best-effort: a failure here (e.g. migration 012 not yet run) must not
  // hide the person's history.
  try {
    await archiveInactiveConversations(userId);
  } catch (error) {
    console.warn("Auto-archive skipped:", error instanceof Error ? error.message : error);
  }

  const result =
    await pool.query<{
      id: string;
      title: string;
      archived: boolean;
      is_pinned: boolean;
      created_at: Date;
      updated_at: Date;
      archived_at: Date | null;
      archived_reason: "manual" | "inactive" | null;
    }>(
      `
        SELECT
          id,
          title,
          archived,
          is_pinned,
          created_at,
          updated_at,
          (to_jsonb(conversations) ->> 'archived_at')::timestamptz AS archived_at,
          to_jsonb(conversations) ->> 'archived_reason' AS archived_reason
        FROM conversations
        WHERE user_id = $1
          AND archived = $2
        ORDER BY
          CASE WHEN $2 THEN FALSE ELSE is_pinned END DESC,
          updated_at DESC
      `,
      [userId, archived],
    );

  return result.rows.map(
    (row) => ({
      id: row.id,
      title: row.title,
      archived:
        row.archived,
      isPinned:
        row.is_pinned,
      createdAt:
        row.created_at
          .toISOString(),
      updatedAt:
        row.updated_at
          .toISOString(),
      archivedAt:
        row.archived && row.archived_at
          ? row.archived_at.toISOString()
          : null,
      archivedReason:
        row.archived ? row.archived_reason ?? null : null,
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
      is_pinned: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        SELECT
          id,
          title,
          archived,
          is_pinned,
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
      feedback_rating: "up" | "down" | null;
      feedback_reason: string | null;
      feedback_comment: string | null;
    }>(
      `
        SELECT
          m.id,
          m.role,
          m.content,
          m.sources,
          m.metadata,
          m.created_at,
          f.rating AS feedback_rating,
          f.reason AS feedback_reason,
          f.comment AS feedback_comment
        FROM conversation_messages m
        LEFT JOIN message_feedback f
          ON f.message_id = m.id
        WHERE m.conversation_id = $1
        ORDER BY
          m.created_at,
          m.id
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
      isPinned:
        conversationRow.is_pinned,
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
          feedback:
            row.feedback_rating
              ? {
                  rating:
                    row.feedback_rating,
                  reason:
                    row.feedback_reason,
                  comment:
                    row.feedback_comment,
                }
              : null,
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

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

async function assertAssistantMessage(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  await assertConversationOwner(userId, conversationId);

  const result = await pool.query(
    `
      SELECT 1
      FROM conversation_messages
      WHERE id = $1
        AND conversation_id = $2
        AND role = 'assistant'
    `,
    [messageId, conversationId],
  );

  if (!result.rowCount) {
    throw notFound("Answer not found in this conversation.");
  }
}

/**
 * Record, change or clear (rating = null) the user's vote on one answer.
 */
export async function setMessageFeedback(
  userId: string,
  conversationId: string,
  messageId: string,
  input: {
    rating: "up" | "down" | null;
    reason?: string | null;
    comment?: string | null;
  },
): Promise<MessageFeedback | null> {
  await assertAssistantMessage(userId, conversationId, messageId);

  if (input.rating === null) {
    await pool.query(
      "DELETE FROM message_feedback WHERE message_id = $1",
      [messageId],
    );
    return null;
  }

  const result = await pool.query<{
    rating: "up" | "down";
    reason: string | null;
    comment: string | null;
  }>(
    `
      INSERT INTO message_feedback (
        message_id, user_id, rating, reason, comment
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (message_id) DO UPDATE SET
        rating = EXCLUDED.rating,
        reason = EXCLUDED.reason,
        comment = EXCLUDED.comment,
        updated_at = NOW()
      RETURNING rating, reason, comment
    `,
    [
      messageId,
      userId,
      input.rating,
      input.rating === "down" ? input.reason?.trim() || null : null,
      input.comment?.trim() || null,
    ],
  );

  return result.rows[0];
}

/**
 * Replace a regenerated answer in place. The previous answer is kept in
 * metadata.previousVersions for audit, and any vote on it is cleared because
 * it applied to the old text.
 */
export async function replaceAssistantMessage(
  userId: string,
  conversationId: string,
  messageId: string,
  input: {
    content: string;
    sources?: unknown[];
    metadata?: Record<string, unknown>;
  },
): Promise<ConversationMessage> {
  await assertAssistantMessage(userId, conversationId, messageId);

  const content = input.content.trim();
  if (!content) {
    throw new Error("Message content is required.");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query<{
      id: string;
      role: "user" | "assistant";
      content: string;
      sources: unknown[];
      metadata: Record<string, unknown>;
      created_at: Date;
    }>(
      `
        UPDATE conversation_messages
        SET
          content = $2,
          sources = $3::jsonb,
          metadata = $4::jsonb || jsonb_build_object(
            'previousVersions',
            COALESCE(metadata->'previousVersions', '[]'::jsonb) ||
              jsonb_build_array(jsonb_build_object(
                'content', content,
                'sources', sources,
                'replacedAt', NOW()
              ))
          )
        WHERE id = $1
        RETURNING id, role, content, sources, metadata, created_at
      `,
      [
        messageId,
        content,
        JSON.stringify(input.sources ?? []),
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    await client.query(
      "DELETE FROM message_feedback WHERE message_id = $1",
      [messageId],
    );

    await client.query(
      "UPDATE conversations SET updated_at = NOW() WHERE id = $1",
      [conversationId],
    );

    await client.query("COMMIT");

    const row = result.rows[0];
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      sources: row.sources,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
      feedback: null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
