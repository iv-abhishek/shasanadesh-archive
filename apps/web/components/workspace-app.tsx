"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";

import {
  ChatApp,
} from "./chat-app";
import {
  SearchApp,
} from "./search-app";

interface WorkspaceProfile {
  id: string;
  displayName: string;
  designation: string | null;
  preferredLanguage:
    "en" | "hi";
  defaultScope:
    | "my_departments"
    | "all_departments";
  primaryDepartment:
    string | null;
  departments: string[];
}

interface ConversationSummary {
  id: string;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

const LEGACY_STORAGE_KEY =
  "shasanadesh.workspaceUserId";

async function jsonRequest<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response =
    await fetch(
      url,
      {
        ...init,
        cache: "no-store",
      },
    );

  if (!response.ok) {
    throw new Error(
      `${response.status}: ${await response.text()}`,
    );
  }

  return (
    await response.json()
  ) as T;
}

async function startDevSession(
  userId: string,
): Promise<WorkspaceProfile> {
  const result =
    await jsonRequest<{
      profile:
        WorkspaceProfile;
    }>(
      "/api/session/dev-login",
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json",
        },
        body:
          JSON.stringify({
            userId,
          }),
      },
    );

  return result.profile;
}

function Onboarding({
  departments,
  profiles,
  onLogin,
  onCreated,
}: {
  departments: string[];
  profiles:
    WorkspaceProfile[];
  onLogin:
    (
      profile:
        WorkspaceProfile,
    ) => void;
  onCreated:
    (
      profile:
        WorkspaceProfile,
    ) => void;
}) {
  const [
    displayName,
    setDisplayName,
  ] =
    useState("");

  const [
    designation,
    setDesignation,
  ] =
    useState("");

  const [
    primaryDepartment,
    setPrimaryDepartment,
  ] =
    useState(
      departments[0] ?? "",
    );

  const [
    additionalDepartments,
    setAdditionalDepartments,
  ] =
    useState<string[]>([]);

  const [
    preferredLanguage,
    setPreferredLanguage,
  ] =
    useState<
      "en" | "hi"
    >("en");

  const [
    defaultScope,
    setDefaultScope,
  ] =
    useState<
      | "my_departments"
      | "all_departments"
    >(
      "my_departments",
    );

  const [busy, setBusy] =
    useState(false);

  const [error, setError] =
    useState<string | null>(
      null,
    );

  useEffect(
    () => {
      if (
        !primaryDepartment &&
        departments[0]
      ) {
        setPrimaryDepartment(
          departments[0],
        );
      }
    },
    [
      departments,
      primaryDepartment,
    ],
  );

  const loginExisting =
    async (
      profile:
        WorkspaceProfile,
    ) => {
      if (busy) {
        return;
      }

      setBusy(true);
      setError(null);

      try {
        const loggedIn =
          await startDevSession(
            profile.id,
          );

        onLogin(
          loggedIn,
        );
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : String(caught),
        );
      } finally {
        setBusy(false);
      }
    };

  const submit =
    async (
      event: FormEvent,
    ) => {
      event.preventDefault();

      if (
        busy ||
        !displayName.trim() ||
        !primaryDepartment
      ) {
        return;
      }

      setBusy(true);
      setError(null);

      try {
        const created =
          await jsonRequest<
            WorkspaceProfile
          >(
            "/api/workspace/users",
            {
              method: "POST",
              headers: {
                "content-type":
                  "application/json",
              },
              body:
                JSON.stringify({
                  displayName:
                    displayName.trim(),
                  designation:
                    designation.trim() ||
                    undefined,
                  preferredLanguage,
                  defaultScope,
                  primaryDepartment,
                  additionalDepartments:
                    additionalDepartments
                      .filter(
                        (
                          department,
                        ) =>
                          department !==
                          primaryDepartment,
                      ),
                }),
            },
          );

        const profile =
          await startDevSession(
            created.id,
          );

        onCreated(
          profile,
        );
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : String(caught),
        );
      } finally {
        setBusy(false);
      }
    };

  return (
    <main className="onboarding-shell">
      <div className="onboarding-card">
        <div className="eyebrow">
          Shasanadesh workspace
        </div>

        <h1>
          Continue your workspace.
        </h1>

        <p className="onboarding-copy">
          Development profiles now
          use an HttpOnly session
          cookie. Your profile,
          departments and chat
          history remain in
          PostgreSQL.
        </p>

        {profiles.length >
        0 ? (
          <div className="dev-profile-section">
            <div className="section-label">
              Existing development
              profiles
            </div>

            <div className="dev-profile-list">
              {profiles.map(
                (profile) => (
                  <button
                    type="button"
                    className="dev-profile-button"
                    key={
                      profile.id
                    }
                    disabled={
                      busy
                    }
                    onClick={() =>
                      void loginExisting(
                        profile,
                      )
                    }
                  >
                    <strong>
                      {
                        profile.displayName
                      }
                    </strong>

                    <span>
                      {profile.designation ??
                        "Government officer"}
                    </span>

                    <small>
                      {profile.primaryDepartment ??
                        "No primary department"}
                    </small>
                  </button>
                ),
              )}
            </div>

            <div className="onboarding-divider">
              or create another
              development profile
            </div>
          </div>
        ) : null}

        <form
          className="onboarding-form"
          onSubmit={submit}
        >
          <label>
            Name
            <input
              value={
                displayName
              }
              onChange={(
                event,
              ) =>
                setDisplayName(
                  event.target
                    .value,
                )
              }
              placeholder="Your name"
              required
            />
          </label>

          <label>
            Designation
            <input
              value={
                designation
              }
              onChange={(
                event,
              ) =>
                setDesignation(
                  event.target
                    .value,
                )
              }
              placeholder="e.g. Principal Secretary"
            />
          </label>

          <label>
            Primary department
            <select
              value={
                primaryDepartment
              }
              onChange={(
                event,
              ) =>
                setPrimaryDepartment(
                  event.target
                    .value,
                )
              }
              required
            >
              {departments.map(
                (department) => (
                  <option
                    key={
                      department
                    }
                    value={
                      department
                    }
                  >
                    {department}
                  </option>
                ),
              )}
            </select>
          </label>

          <label>
            Additional departments
            <select
              multiple
              size={6}
              value={
                additionalDepartments
              }
              onChange={(
                event,
              ) =>
                setAdditionalDepartments(
                  Array.from(
                    event.currentTarget
                      .selectedOptions,
                  ).map(
                    (option) =>
                      option.value,
                  ),
                )
              }
            >
              {departments.map(
                (department) => (
                  <option
                    key={
                      department
                    }
                    value={
                      department
                    }
                    disabled={
                      department ===
                      primaryDepartment
                    }
                  >
                    {department}
                  </option>
                ),
              )}
            </select>

            <span className="field-help">
              Use Command-click to
              choose more than one.
            </span>
          </label>

          <div className="onboarding-grid">
            <label>
              Preferred language
              <select
                value={
                  preferredLanguage
                }
                onChange={(
                  event,
                ) =>
                  setPreferredLanguage(
                    event.target
                      .value as
                      | "en"
                      | "hi",
                  )
                }
              >
                <option value="en">
                  English
                </option>
                <option value="hi">
                  Hindi
                </option>
              </select>
            </label>

            <label>
              Default scope
              <select
                value={
                  defaultScope
                }
                onChange={(
                  event,
                ) =>
                  setDefaultScope(
                    event.target
                      .value as
                      | "my_departments"
                      | "all_departments",
                  )
                }
              >
                <option value="my_departments">
                  My departments
                </option>
                <option value="all_departments">
                  All departments
                </option>
              </select>
            </label>
          </div>

          {error ? (
            <div className="error-box">
              {error}
            </div>
          ) : null}

          <button
            className="onboarding-submit"
            type="submit"
            disabled={
              busy ||
              !displayName.trim() ||
              !primaryDepartment
            }
          >
            {busy
              ? "Working…"
              : "Create workspace"}
          </button>
        </form>
      </div>
    </main>
  );
}

export function WorkspaceApp() {
  const [mode, setMode] =
    useState<
      "ask" | "search"
    >("ask");

  const [
    departments,
    setDepartments,
  ] =
    useState<string[]>([]);

  const [
    devProfiles,
    setDevProfiles,
  ] =
    useState<
      WorkspaceProfile[]
    >([]);

  const [
    profile,
    setProfile,
  ] =
    useState<
      WorkspaceProfile | null
    >(null);

  const [
    conversations,
    setConversations,
  ] =
    useState<
      ConversationSummary[]
    >([]);

  const [
    selectedConversationId,
    setSelectedConversationId,
  ] =
    useState<
      string | null
    >(null);

  const [
    chatSessionKey,
    setChatSessionKey,
  ] =
    useState(0);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState<string | null>(
      null,
    );

  const loadHistory =
    useCallback(
      async (
        userId: string,
      ) => {
        const data =
          await jsonRequest<{
            conversations:
              ConversationSummary[];
          }>(
            `/api/workspace/users/${encodeURIComponent(userId)}/conversations`,
          );

        setConversations(
          data.conversations,
        );
      },
      [],
    );

  const refreshHistory =
    useCallback(
      async () => {
        if (!profile) {
          return;
        }

        await loadHistory(
          profile.id,
        );
      },
      [
        loadHistory,
        profile,
      ],
    );

  const loadDevProfiles =
    useCallback(
      async () => {
        const data =
          await jsonRequest<{
            profiles:
              WorkspaceProfile[];
          }>(
            "/api/session/dev-users",
          );

        setDevProfiles(
          data.profiles,
        );
      },
      [],
    );

  const activateProfile =
    useCallback(
      async (
        active:
          WorkspaceProfile,
      ) => {
        setProfile(
          active,
        );

        setSelectedConversationId(
          null,
        );

        setChatSessionKey(
          (current) =>
            current + 1,
        );

        await loadHistory(
          active.id,
        );
      },
      [loadHistory],
    );

  useEffect(
    () => {
      let cancelled =
        false;

      const load =
        async () => {
          try {
            const departmentData =
              await jsonRequest<{
                departments:
                  string[];
              }>(
                "/api/workspace/departments",
              );

            if (cancelled) {
              return;
            }

            setDepartments(
              departmentData
                .departments,
            );

            const sessionResponse =
              await fetch(
                "/api/session/me",
                {
                  cache:
                    "no-store",
                },
              );

            if (
              sessionResponse.ok
            ) {
              const data =
                (
                  await sessionResponse
                    .json()
                ) as {
                  profile:
                    WorkspaceProfile;
                };

              if (cancelled) {
                return;
              }

              setProfile(
                data.profile,
              );

              await loadHistory(
                data.profile.id,
              );

              return;
            }

            // One-time migration from the old localStorage-only development
            // identity. Once a cookie session is created, the legacy value is
            // deleted and never used again.
            const legacyUserId =
              localStorage.getItem(
                LEGACY_STORAGE_KEY,
              );

            if (legacyUserId) {
              try {
                const migrated =
                  await startDevSession(
                    legacyUserId,
                  );

                localStorage.removeItem(
                  LEGACY_STORAGE_KEY,
                );

                if (cancelled) {
                  return;
                }

                setProfile(
                  migrated,
                );

                await loadHistory(
                  migrated.id,
                );

                return;
              } catch {
                localStorage.removeItem(
                  LEGACY_STORAGE_KEY,
                );
              }
            }

            await loadDevProfiles();
          } catch (caught) {
            if (!cancelled) {
              setError(
                caught instanceof Error
                  ? caught.message
                  : String(
                      caught,
                    ),
              );
            }
          } finally {
            if (!cancelled) {
              setLoading(
                false,
              );
            }
          }
        };

      void load();

      return () => {
        cancelled = true;
      };
    },
    [
      loadDevProfiles,
      loadHistory,
    ],
  );

  const newChat = () => {
    setSelectedConversationId(
      null,
    );

    setChatSessionKey(
      (current) =>
        current + 1,
    );

    setMode("ask");
  };

  const switchProfile =
    async () => {
      try {
        await jsonRequest<{
          ok: boolean;
        }>(
          "/api/session/logout",
          {
            method: "POST",
          },
        );
      } catch {
        // Even if server logout fails, do not invent a new local identity.
      }

      setProfile(
        null,
      );

      setConversations(
        [],
      );

      setSelectedConversationId(
        null,
      );

      setChatSessionKey(
        (current) =>
          current + 1,
      );

      setMode(
        "ask",
      );

      await loadDevProfiles();
    };

  if (loading) {
    return (
      <main className="onboarding-shell">
        <div className="muted">
          Loading workspace…
        </div>
      </main>
    );
  }

  if (!profile) {
    return (
      <Onboarding
        departments={
          departments
        }
        profiles={
          devProfiles
        }
        onLogin={(
          active,
        ) => {
          void activateProfile(
            active,
          );
        }}
        onCreated={(
          created,
        ) => {
          void activateProfile(
            created,
          );

          void loadDevProfiles();
        }}
      />
    );
  }

  return (
    <div className="workspace-layout">
      <aside className="history-sidebar">
        <div className="history-profile">
          <div className="history-avatar">
            {profile.displayName
              .trim()
              .slice(0, 1)
              .toUpperCase()}
          </div>

          <div>
            <strong>
              {profile.displayName}
            </strong>

            <div className="history-designation">
              {profile.designation ??
                "Government officer"}
            </div>
          </div>
        </div>

        <div className="history-scope">
          <div className="section-label">
            Working scope
          </div>

          <strong>
            {profile.primaryDepartment ??
              "No primary department"}
          </strong>

          {profile.departments
            .filter(
              (department) =>
                department !==
                profile
                  .primaryDepartment,
            )
            .map(
              (department) => (
                <span
                  key={
                    department
                  }
                >
                  {department}
                </span>
              ),
            )}
        </div>

        <button
          type="button"
          className="new-chat-button"
          onClick={newChat}
        >
          + New chat
        </button>

        <button
          type="button"
          className="switch-profile-button"
          onClick={() =>
            void switchProfile()
          }
        >
          Switch development
          profile
        </button>

        <div className="history-heading">
          History
        </div>

        <nav className="history-list">
          {conversations.length ===
          0 ? (
            <div className="history-empty">
              Your saved conversations
              will appear here.
            </div>
          ) : (
            conversations.map(
              (conversation) => (
                <button
                  type="button"
                  key={
                    conversation.id
                  }
                  className={
                    selectedConversationId ===
                    conversation.id
                      ? "history-item active"
                      : "history-item"
                  }
                  onClick={() => {
                    setSelectedConversationId(
                      conversation.id,
                    );

                    setChatSessionKey(
                      (
                        current,
                      ) =>
                        current + 1,
                    );

                    setMode(
                      "ask",
                    );
                  }}
                >
                  <span>
                    {
                      conversation.title
                    }
                  </span>

                  <small>
                    {new Date(
                      conversation
                        .updatedAt,
                    ).toLocaleDateString()}
                  </small>
                </button>
              ),
            )
          )}
        </nav>

        <div className="history-footer">
          HttpOnly development
          session
        </div>
      </aside>

      <div className="workspace-main">
        <div className="workspace-switch">
          <button
            type="button"
            className={
              mode === "ask"
                ? "workspace-switch-button active"
                : "workspace-switch-button"
            }
            onClick={() =>
              setMode("ask")
            }
          >
            Ask
          </button>

          <button
            type="button"
            className={
              mode === "search"
                ? "workspace-switch-button active"
                : "workspace-switch-button"
            }
            onClick={() =>
              setMode(
                "search",
              )
            }
          >
            Search
          </button>
        </div>

        {error ? (
          <div className="workspace-error">
            {error}
          </div>
        ) : null}

        {mode === "ask" ? (
          <ChatApp
            key={`${chatSessionKey}-${selectedConversationId ?? "new"}`}
            workspaceUserId={
              profile.id
            }
            conversationId={
              selectedConversationId
            }
            onHistoryChanged={() =>
              void refreshHistory()
            }
          />
        ) : (
          <SearchApp />
        )}
      </div>
    </div>
  );
}
