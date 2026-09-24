import assert from "node:assert/strict";

import {
  buildSessionCookie,
  clearSessionCookie,
  readSessionToken,
} from "./session-cookie.js";

assert.equal(
  readSessionToken(
    "x=1; shasanadesh_session=abc%20123; y=2",
  ),
  "abc 123",
);

assert.equal(
  readSessionToken(
    undefined,
  ),
  null,
);

{
  const cookie =
    buildSessionCookie(
      "token-value",
      3600,
      false,
    );

  assert.match(
    cookie,
    /shasanadesh_session=token-value/,
  );

  assert.match(
    cookie,
    /HttpOnly/,
  );

  assert.match(
    cookie,
    /SameSite=Lax/,
  );

  assert.doesNotMatch(
    cookie,
    /Secure/,
  );
}

assert.match(
  buildSessionCookie(
    "token-value",
    3600,
    true,
  ),
  /Secure/,
);

assert.match(
  clearSessionCookie(
    false,
  ),
  /Max-Age=0/,
);

console.log(
  "session-cookie tests passed",
);
