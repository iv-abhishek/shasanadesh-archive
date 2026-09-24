# User Workspace and Conversation Persistence

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


## Frontend workspace shell

The development UI now supports:

- first-run profile creation;
- primary and additional department selection;
- preferred language and default-scope preferences;
- persistent conversation list;
- new-chat flow;
- reopening prior conversations;
- automatic persistence of completed user/assistant turns;
- persistence of the dominant retrieved source/department as conversation state.

Only the workspace UUID is stored in browser local storage. The durable profile and chat
history remain in PostgreSQL.

The profile's multi-department scope is not yet applied as an OR retrieval filter. That
requires explicit multi-department retrieval semantics and will be added separately so a
senior officer's 1-4 department profile is not incorrectly reduced to only the primary
department.


## Working-scope retrieval

For `defaultScope = my_departments`, standalone substantive chat questions are constrained
to all active working departments using OR semantics.

Explicit source/department requests take precedence. Likely follow-ups still prefer the
active conversation source. Pure social turns are saved in history but do not mutate the
persistent active source, department, or topic.


## Cookie-backed development sessions

The browser now uses an HttpOnly `shasanadesh_session` cookie for development identity
continuity. The cookie contains only an opaque random token.

The server stores only a SHA-256 hash of that token in `workspace_sessions`. Durable
workspace state remains in PostgreSQL.

Development endpoints:

- `GET /api/session/me`
- `GET /api/session/dev-users`
- `POST /api/session/dev-login`
- `POST /api/session/logout`

The frontend can switch between existing development profiles without editing
localStorage. Existing localStorage-only profiles are migrated once into a cookie session
and the legacy value is deleted.

The RAG chat proxy forwards the cookie to the API. When both a cookie session and a
legacy caller-supplied workspace UUID exist, the valid cookie session wins.

This mechanism provides development continuity, not production authentication. Real SSO
or another identity provider should replace `dev-login` before deployment to real users.
