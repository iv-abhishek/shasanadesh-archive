import type {
  FastifyInstance,
} from "fastify";
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
