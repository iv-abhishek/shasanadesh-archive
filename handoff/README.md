# Handoff — read this first

This folder lets any new chat (or person) pick up the project exactly where the
last one stopped. It is committed to git, so it survives a broken chat, a lost
laptop session and is pushed to GitHub with the code.

| File          | What it holds                                                                                            | Who updates it                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `STATUS.md`   | Where things stand right now: what works, what is running, open problems, the exact next commands        | Claude, at every milestone and at least every 2–3 hours of active work |
| `PLAN.md`     | The roadmap and the current route for each workstream; changed whenever a route changes, with the reason | Claude, when a decision changes                                        |
| `LOG.md`      | Dated, append-only log of sessions, decisions and results (newest first)                                 | Claude, each working session                                           |
| `SNAPSHOT.md` | Generated facts: git head, recent commits, uncommitted files, corpus counts per source                   | `npm run handoff:snapshot`                                             |

## Restoring after a broken chat

1. Open a new Claude chat linked to this computer (desktop app, folder
   `~/Downloads/projectai` connected).
2. Paste:

   > Continue the Shasanadesh project. Read `shasanadesh/handoff/README.md`,
   > `STATUS.md`, `PLAN.md` and the top of `LOG.md`, then run
   > `npm run handoff:snapshot` and carry on with the "Next" items in STATUS.md.

3. Nothing else is needed: the rules below and the docs in `docs/` hold the rest.

## Working rules (keep these when resuming)

- Commit author: `Abhishek Srivastava <adder.neo@gmail.com>`; the user pushes to
  GitHub (`git push`) themselves. Claude commits locally only.
- Use `git --no-optional-locks` for read-only git commands so no stale
  `.git/index.lock` is left behind.
- Never commit or print secrets (`.env`, `apps/web/.env.local`, B2 keys).
- Comment code as described in `docs/CODE_COMMENTING.md`: every pipeline file has
  a header (stage, purpose, invariants); explain _why_, not _what_.
- Record lasting decisions as ADRs in `docs/DECISIONS.md`; update `PLAN.md` when
  a route changes.
- Test before committing: unit tests (`npm run test:*`), web type-check, and a
  browser check for UI changes.
- Update `STATUS.md` + `LOG.md` and run `npm run handoff:snapshot` at every
  commit-worthy milestone, and at least every 2–3 hours of active work.

Chat GPT Conversation:

https://chatgpt.com/s/cx_6ab7aa2dcd848191b85c92946ed6aad8
