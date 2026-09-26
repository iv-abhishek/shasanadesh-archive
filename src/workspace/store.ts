/**
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
}

export interface ConversationSummary {
  id: string;
  title: string;
  archived: boolean;
  isPinned: boolean;
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
          input.stateName
            ?.trim() || null,
          input.district
            ?.trim() || null,
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
            input.stateName
              ?.trim() || null,
            input.district
              ?.trim() || null,
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
    }>(
      `
        UPDATE conversations
        SET title = COALESCE($3, title),
            is_pinned = COALESCE($4, is_pinned),
            archived = COALESCE($5, archived),
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
          updated_at
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

export async function listConversations(
  userId: string,
  archived = false,
): Promise<ConversationSummary[]> {
  await getWorkspaceProfile(
    userId,
  );

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
        SELECT
          id,
          title,
          archived,
          is_pinned,
          created_at,
          updated_at
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
