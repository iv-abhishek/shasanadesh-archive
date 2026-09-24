export const SESSION_COOKIE_NAME =
  "shasanadesh_session";

export function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (
    const part of
      cookieHeader.split(";")
  ) {
    const separator =
      part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key =
      part
        .slice(
          0,
          separator,
        )
        .trim();

    if (key !== name) {
      continue;
    }

    const value =
      part
        .slice(
          separator + 1,
        )
        .trim();

    try {
      return decodeURIComponent(
        value,
      );
    } catch {
      return value;
    }
  }

  return null;
}

export function readSessionToken(
  cookieHeader:
    string | undefined,
): string | null {
  return readCookie(
    cookieHeader,
    SESSION_COOKIE_NAME,
  );
}

export function buildSessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(
      0,
      Math.floor(
        maxAgeSeconds,
      ),
    )}`,
  ];

  if (secure) {
    attributes.push(
      "Secure",
    );
  }

  return attributes.join(
    "; ",
  );
}

export function clearSessionCookie(
  secure: boolean,
): string {
  return buildSessionCookie(
    "",
    0,
    secure,
  );
}
