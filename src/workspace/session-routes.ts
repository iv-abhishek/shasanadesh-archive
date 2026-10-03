import type {
  FastifyInstance,
} from "fastify";
import { MAX_WORKSPACE_PROFILES } from "./model.js";
import {
  z,
} from "zod";

import {
  buildSessionCookie,
  clearSessionCookie,
} from "./session-cookie.js";
import {
  createDevelopmentSession,
  listDevelopmentProfiles,
  resolveSessionFromCookie,
  revokeSessionFromCookie,
} from "./session-store.js";
import {
  countProfileConversations,
  listDeletedProfiles,
  PROFILE_RESTORE_DAYS,
  purgeDeletedProfiles,
  restoreWorkspaceProfile,
  softDeleteWorkspaceProfile,
} from "./store.js";

const ProfileIdParams = z.object({ id: z.string().uuid() });

const DevLoginSchema =
  z.object({
    userId:
      z.string()
        .uuid(),
  });

function secureCookie():
  boolean {
  return (
    process.env.NODE_ENV ===
    "production"
  );
}

export function registerSessionRoutes(
  server: FastifyInstance,
): void {
  server.get(
    "/api/session/me",
    async (
      request,
      reply,
    ) => {
      const session =
        await resolveSessionFromCookie(
          request.headers
            .cookie,
        );

      if (!session) {
        return reply
          .code(401)
          .send({
            error:
              "No active session.",
          });
      }

      return {
        profile:
          session.profile,
        session: {
          expiresAt:
            session.expiresAt,
        },
      };
    },
  );

  server.get(
    "/api/session/dev-users",
    async (
      _request,
      reply,
    ) => {
      if (
        process.env
          .NODE_ENV ===
        "production"
      ) {
        return reply
          .code(404)
          .send({
            error:
              "Not found.",
          });
      }

      // The profile picker is visible before sign-in, so it must not expose
      // private profile details. Contact numbers are only returned to the
      // profile's own session (via /api/session/me and the workspace routes).
      const profiles =
        await listDevelopmentProfiles();

      return {
        profiles: profiles.map(
          (profile) => ({
            ...profile,
            contactNumber: null,
          }),
        ),
        maxProfiles: MAX_WORKSPACE_PROFILES,
      };
    },
  );

  server.post(
    "/api/session/dev-login",
    async (
      request,
      reply,
    ) => {
      if (
        process.env
          .NODE_ENV ===
        "production"
      ) {
        return reply
          .code(404)
          .send({
            error:
              "Not found.",
          });
      }

      const parsed =
        DevLoginSchema.safeParse(
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

      const created =
        await createDevelopmentSession(
          parsed.data
            .userId,
        );

      reply.header(
        "set-cookie",
        buildSessionCookie(
          created.token,
          created
            .maxAgeSeconds,
          secureCookie(),
        ),
      );

      return {
        profile:
          created.profile,
        session: {
          expiresAt:
            created.expiresAt,
        },
      };
    },
  );

  // Profile delete (ADR-079). Development profiles have no owner yet, so these
  // sit with dev-login and are off in production; with real accounts they move
  // to /api/account/profiles and only touch the account's own profiles.
  const developmentOnly = (reply: { code: (status: number) => { send: (body: unknown) => unknown } }) =>
    process.env.NODE_ENV === "production" ? reply.code(404).send({ error: "Not found." }) : null;

  server.get("/api/session/dev-users/deleted", async (_request, reply) => {
    const blocked = developmentOnly(reply);
    if (blocked) return blocked;
    return { profiles: await listDeletedProfiles(), restoreDays: PROFILE_RESTORE_DAYS };
  });

  server.get("/api/session/dev-users/:id/summary", async (request, reply) => {
    const blocked = developmentOnly(reply);
    if (blocked) return blocked;
    const params = ProfileIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid profile ID." });
    return { conversationCount: await countProfileConversations(params.data.id), restoreDays: PROFILE_RESTORE_DAYS };
  });

  server.delete("/api/session/dev-users/:id", async (request, reply) => {
    const blocked = developmentOnly(reply);
    if (blocked) return blocked;
    const params = ProfileIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid profile ID." });
    const current = await resolveSessionFromCookie(request.headers.cookie);
    const { purgeAfter } = await softDeleteWorkspaceProfile(params.data.id);
    // Deleting the profile you are using signs you out of it.
    const signedOut = current?.userId === params.data.id;
    if (signedOut) reply.header("set-cookie", clearSessionCookie(secureCookie()));
    return { ok: true, purgeAfter, signedOut };
  });

  server.post("/api/session/dev-users/:id/restore", async (request, reply) => {
    const blocked = developmentOnly(reply);
    if (blocked) return blocked;
    const params = ProfileIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid profile ID." });
    await restoreWorkspaceProfile(params.data.id);
    return { ok: true };
  });

  server.delete("/api/session/dev-users/:id/permanent", async (request, reply) => {
    const blocked = developmentOnly(reply);
    if (blocked) return blocked;
    const params = ProfileIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid profile ID." });
    const purged = await purgeDeletedProfiles(params.data.id);
    if (!purged) return reply.code(404).send({ error: "Only a deleted profile can be removed permanently." });
    return { ok: true };
  });

  server.post(
    "/api/session/logout",
    async (
      request,
      reply,
    ) => {
      await revokeSessionFromCookie(
        request.headers
          .cookie,
      );

      reply.header(
        "set-cookie",
        clearSessionCookie(
          secureCookie(),
        ),
      );

      return {
        ok: true,
      };
    },
  );
}
