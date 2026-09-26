/**
 * Workspace/profile/history routes.
 *
 * These routes back the development workspace shell. Per-profile reads and
 * writes require a matching HttpOnly session; development profile creation is
 * still open because there is no production identity provider yet.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
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
  updateConversation,
  deleteConversation,
  updateWorkspaceUser,
} from "./store.js";
import {
  resolveSessionFromCookie,
} from "./session-store.js";

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
    stateName:
      z.string()
        .trim()
        .max(100)
        .optional(),
    district:
      z.string()
        .trim()
        .max(100)
        .optional(),
    contactNumber:
      z.string()
        .trim()
        .max(32)
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

const ConversationPatchSchema =
  z.object({
    title: z.string().trim().min(1).max(200).optional(),
    isPinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  }).refine((input) =>
    input.title !== undefined
      || input.isPinned !== undefined
      || input.archived !== undefined,
  );

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

async function authorizeWorkspaceUser(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<boolean> {
  const session =
    await resolveSessionFromCookie(
      request.headers.cookie,
    );

  if (!session) {
    reply.code(401).send({
      error: "An active workspace session is required.",
    });
    return false;
  }

  if (session.userId !== userId) {
    reply.code(403).send({
      error: "This workspace belongs to a different profile.",
    });
    return false;
  }

  return true;
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
        if (!(await authorizeWorkspaceUser(
          request,
          reply,
          request.params.userId,
        ))) return;

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
        if (!(await authorizeWorkspaceUser(
          request,
          reply,
          request.params.userId,
        ))) return;

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
    Querystring: {
      archived?: string;
    };
  }>(
    "/api/workspace/users/:userId/conversations",
    async (
      request,
      reply,
    ) => {
      try {
        if (!(await authorizeWorkspaceUser(
          request,
          reply,
          request.params.userId,
        ))) return;

        return {
          conversations:
            await listConversations(
              request.params
                .userId,
              request.query.archived === "true",
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
        if (!(await authorizeWorkspaceUser(
          request,
          reply,
          request.params.userId,
        ))) return;

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
        if (!(await authorizeWorkspaceUser(
          request,
          reply,
          request.params.userId,
        ))) return;

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
        if (!(await authorizeWorkspaceUser(
          request,
          reply,
          request.params.userId,
        ))) return;

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
        if (!(await authorizeWorkspaceUser(
          request,
          reply,
          request.params.userId,
        ))) return;

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

  server.patch<{
    Params: {
      userId: string;
      conversationId: string;
    };
  }>(
    "/api/workspace/users/:userId/conversations/:conversationId",
    async (request, reply) => {
      const parsed =
        ConversationPatchSchema.safeParse(
          request.body,
        );

      if (!parsed.success) {
        return reply.code(400).send({
          error: parsed.error.flatten(),
        });
      }

      try {
        if (!(await authorizeWorkspaceUser(
          request,
          reply,
          request.params.userId,
        ))) return;

        return await updateConversation(
          request.params.userId,
          request.params.conversationId,
          parsed.data,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  server.delete<{
    Params: {
      userId: string;
      conversationId: string;
    };
  }>(
    "/api/workspace/users/:userId/conversations/:conversationId",
    async (request, reply) => {
      try {
        if (!(await authorizeWorkspaceUser(
          request,
          reply,
          request.params.userId,
        ))) return;

        await deleteConversation(
          request.params.userId,
          request.params.conversationId,
        );

        return { ok: true };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}
