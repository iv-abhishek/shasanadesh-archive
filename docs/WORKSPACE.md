# User Workspace and Conversation Persistence

## Purpose

The product needs three independent layers:

1. **Authorization** — what a real user is allowed to access.
2. **Working scope** — which departments the user normally works with.
3. **Conversation context** — what the current thread is about.

This implementation adds persistence for layers 2 and 3. It does **not** implement
authentication or authorization yet.

## User profile

A development workspace profile currently stores:

- display name
- designation
- preferred response language
- default search scope
- primary department
- additional working departments

Department assignments are temporal. Updating a profile closes the previous active
assignments instead of deleting them, allowing future posting/transfer history.

State, district, verified official identity, public/official profile type, and contact
details are not implemented. Do not add real phone numbers to the current development
profile store: its routes do not provide production authentication or access control.

## Conversation history

Each conversation stores:

- title
- ordered user/assistant messages
- source cards attached to assistant messages
- arbitrary per-message metadata
- persistent active source/department/topic state

This lets the product reopen a conversation without feeding the entire raw history to the
generator.

## Implemented retrieval precedence

For substantive chat, the API currently applies:

1. explicit source requested in the current question;
2. explicit department requested in the current question;
3. active conversation source or department for likely follow-ups;
4. all active profile departments when default scope is my_departments;
5. global corpus when the profile is global or the user explicitly asks for it.

The profile's departments are combined with OR semantics. An explicit source or
department takes precedence over the profile defaults. Working scope is a relevance
default, not an access-control boundary.

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

The durable profile and chat history remain in PostgreSQL. The active development
session uses the HttpOnly cookie described below; a legacy localStorage UUID is accepted
only for one-time migration.


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

## Product direction for profile types

The product should offer general/public access with optional department interests and a
separate government-official profile with name, designation, state, district, and one or
more active departments. These are product preferences and claims until verified by a
real identity provider. Server-side authorization must be independent of department
scope.

Phone number should remain optional and private, and should be collected only after
authenticated identity and an actual contact use case exist. It is not part of the current
workspace schema or development UI.
