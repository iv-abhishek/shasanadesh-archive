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
import { appDayKey, formatDayKey, previousDayKey } from "../lib/app-time";

interface WorkspaceProfile {
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
  additionalChargeDepartments?: string[];
}

interface ConversationSummary {
  id: string;
  title: string;
  archived: boolean;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
}

function conversationDateGroups(items: ConversationSummary[]) {
  // Day boundaries follow the configured app zone (IST by default), not the
  // browser's or the host's zone.
  const todayKey = appDayKey(new Date());
  const yesterdayKey = previousDayKey(todayKey);
  const grouped = new Map<string, ConversationSummary[]>();

  for (const conversation of items) {
    const key = appDayKey(conversation.updatedAt);
    grouped.set(key, [...(grouped.get(key) ?? []), conversation]);
  }

  return [...grouped.entries()].map(([key, conversations]) => {
    const label = key === todayKey
      ? "Today"
      : key === yesterdayKey
        ? "Yesterday"
        : formatDayKey(key, key.slice(0, 4) !== todayKey.slice(0, 4));
    return { key, label, conversations };
  });
}

const INDIA_STATES_AND_UTS = [
  "Andaman and Nicobar Islands",
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chandigarh",
  "Chhattisgarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jammu and Kashmir",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Ladakh",
  "Lakshadweep",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Puducherry",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
  "Central Government / Other",
];

// Officers may hold several departments at once: a substantive posting,
// additional charge of others, both, or none. Each selected department can be
// flagged as "additional charge"; all selected departments are searched.
function DepartmentChecklist({
  departments,
  primaryDepartment,
  selected,
  onChange,
  charged,
  onChargedChange,
}: {
  departments: string[];
  primaryDepartment: string;
  selected: string[];
  onChange: (next: string[]) => void;
  charged: string[];
  onChargedChange: (next: string[]) => void;
}) {
  const selectable = departments.filter(
    (department) => department !== primaryDepartment,
  );

  if (selectable.length === 0) {
    return (
      <div className="field-help">
        No other departments are available yet.
      </div>
    );
  }

  const toggle = (department: string) => {
    if (selected.includes(department)) {
      onChange(selected.filter((item) => item !== department));
      onChargedChange(charged.filter((item) => item !== department));
    } else {
      onChange([...selected, department]);
    }
  };

  const toggleCharge = (department: string) => {
    onChargedChange(
      charged.includes(department)
        ? charged.filter((item) => item !== department)
        : [...charged, department],
    );
  };

  return (
    <div className="department-checklist" aria-label="Other departments">
      {selectable.map((department) => {
        const isSelected = selected.includes(department);
        const isCharged = isSelected && charged.includes(department);

        return (
          <div className="department-option-row" key={department}>
            <label className="department-option">
              <input
                type="checkbox"
                checked={isSelected}
                disabled={!isSelected && selected.length >= 12}
                onChange={() => toggle(department)}
              />
              <span>{department}</span>
            </label>
            {isSelected ? (
              <button
                type="button"
                className={isCharged ? "charge-toggle active" : "charge-toggle"}
                aria-pressed={isCharged}
                title="Mark if you hold this department as additional charge"
                onClick={() => toggleCharge(department)}
              >
                Addl. charge
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function scopeHelp(
  primaryDepartment: string,
  otherDepartments: string[],
): string {
  if (!primaryDepartment && otherDepartments.length === 0) {
    return "No department selected: your questions will search all departments.";
  }
  const count = (primaryDepartment ? 1 : 0) + otherDepartments.length;
  return `Questions search ${count === 1 ? "this department" : `these ${count} departments`} by default. You can still ask about any other department or order in the chat.`;
}

const LEGACY_STORAGE_KEY =
  "shasanadesh.workspaceUserId";
const THEME_STORAGE_KEY =
  "shasanadesh.colorTheme";

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
    const responseText = await response.text();
    let message = responseText || response.statusText;
    try {
      const payload = JSON.parse(responseText) as {
        message?: unknown;
        error?: unknown;
      };
      if (typeof payload.message === "string") {
        message = payload.message;
      } else if (typeof payload.error === "string") {
        message = payload.error;
      }
    } catch {
      // Keep the plain response body when the server did not return JSON.
    }
    throw new Error(`${response.status}: ${message}`);
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

function ProfileEditor({
  profile,
  departments,
  busy,
  onCancel,
  onSave,
}: {
  profile: WorkspaceProfile;
  departments: string[];
  busy: boolean;
  onCancel: () => void;
  onSave: (input: {
    displayName: string;
    designation?: string;
    stateName?: string;
    district?: string;
    contactNumber?: string;
    preferredLanguage: "en" | "hi";
    defaultScope: "my_departments" | "all_departments";
    primaryDepartment: string | null;
    additionalDepartments: string[];
    additionalChargeDepartments: string[];
  }) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [designation, setDesignation] = useState(profile.designation ?? "");
  const [stateName, setStateName] = useState(profile.stateName ?? "");
  const [district, setDistrict] = useState(profile.district ?? "");
  const [contactNumber, setContactNumber] = useState(profile.contactNumber ?? "");
  const [primaryDepartment, setPrimaryDepartment] = useState(
    profile.primaryDepartment ?? "",
  );
  const [additionalCharge, setAdditionalCharge] = useState<string[]>(
    profile.additionalChargeDepartments ?? [],
  );
  const [additionalDepartments, setAdditionalDepartments] = useState(
    profile.departments.filter(
      (department) => department !== profile.primaryDepartment,
    ),
  );
  const [preferredLanguage, setPreferredLanguage] = useState<"en" | "hi">(
    profile.preferredLanguage,
  );
  const [defaultScope, setDefaultScope] = useState<
    "my_departments" | "all_departments"
  >(profile.defaultScope);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !displayName.trim()) return;
    const others = additionalDepartments.filter(
      (department) => department !== primaryDepartment,
    );
    void onSave({
      displayName: displayName.trim(),
      designation: designation.trim() || undefined,
      stateName: stateName || undefined,
      district: district.trim() || undefined,
      contactNumber: contactNumber.trim() || undefined,
      preferredLanguage,
      defaultScope,
      primaryDepartment: primaryDepartment || null,
      additionalDepartments: others,
      additionalChargeDepartments: additionalCharge.filter((department) =>
        others.includes(department),
      ),
    });
  };

  return (
    <main className="profile-page">
      <div className="profile-page-top">
        <div>
          <div className="eyebrow">Workspace settings</div>
          <h1>Profile and departments</h1>
          <p>
            Set your working departments and default search behavior. Your saved
            conversations stay with this profile when these details change.
          </p>
        </div>
        <button
          type="button"
          className="profile-cancel-button"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
      </div>

      <form className="profile-editor" onSubmit={submit}>
        <section className="profile-editor-section">
          <div className="section-label">Professional details</div>
          <div className="profile-form-grid">
            <label>
              Name
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
                required
              />
            </label>
            <label>
              Designation
              <input
                value={designation}
                onChange={(event) => setDesignation(event.target.value)}
                placeholder="e.g. Principal Secretary"
              />
            </label>
            <label>
              State or Union Territory
              <select
                value={stateName}
                onChange={(event) => setStateName(event.target.value)}
              >
                <option value="">Not specified</option>
                {INDIA_STATES_AND_UTS.map((state) => (
                  <option key={state} value={state}>{state}</option>
                ))}
              </select>
            </label>
            <label>
              District
              <input
                value={district}
                onChange={(event) => setDistrict(event.target.value)}
                placeholder="Optional"
                autoComplete="address-level2"
              />
            </label>
            <label>
              Contact number <span className="field-optional">Optional</span>
              <input
                type="tel"
                value={contactNumber}
                onChange={(event) => setContactNumber(event.target.value)}
                placeholder="For this workspace profile"
                autoComplete="tel"
              />
              <span className="field-help">
                This is profile information only; it is not used to sign in.
              </span>
            </label>
          </div>
        </section>

        <section className="profile-editor-section">
          <div className="section-label">Department scope</div>
          <p className="field-help">
            An officer may have a substantive posting, additional charge of
            other departments, both, or no department at all.
          </p>
          <label>
            Substantive (primary) department
            <select
              value={primaryDepartment}
              onChange={(event) => {
                const next = event.target.value;
                setPrimaryDepartment(next);
                setAdditionalDepartments((current) =>
                  current.filter((department) => department !== next),
                );
                setAdditionalCharge((current) =>
                  current.filter((department) => department !== next),
                );
              }}
            >
              <option value="">None</option>
              {departments.map((department) => (
                <option key={department} value={department}>{department}</option>
              ))}
            </select>
          </label>
          <div className="profile-field-block">
            <div className="profile-field-label">Other departments</div>
            <p className="field-help">
              Select up to 12 departments you work with. Mark{" "}
              <strong>Addl. charge</strong> for departments you hold as
              additional charge.
            </p>
            <DepartmentChecklist
              departments={departments}
              primaryDepartment={primaryDepartment}
              selected={additionalDepartments}
              onChange={setAdditionalDepartments}
              charged={additionalCharge}
              onChargedChange={setAdditionalCharge}
            />
          </div>
          <div className="profile-form-grid">
            <label>
              Preferred language
              <select
                value={preferredLanguage}
                onChange={(event) =>
                  setPreferredLanguage(event.target.value as "en" | "hi")
                }
              >
                <option value="en">English</option>
                <option value="hi">Hindi</option>
              </select>
            </label>
            <label>
              Default document scope
              <select
                value={defaultScope}
                onChange={(event) =>
                  setDefaultScope(
                    event.target.value as "my_departments" | "all_departments",
                  )
                }
              >
                <option value="my_departments">My departments</option>
                <option value="all_departments">All departments</option>
              </select>
            </label>
          </div>
          <p className="field-help">
            {scopeHelp(
              primaryDepartment,
              additionalDepartments.filter(
                (department) => department !== primaryDepartment,
              ),
            )}
          </p>
        </section>

        <div className="profile-editor-actions">
          <span className="field-help">Your saved chats are retained.</span>
          <button
            className="onboarding-submit"
            type="submit"
            disabled={busy || !displayName.trim()}
          >
            {busy ? "Saving…" : "Save profile"}
          </button>
        </div>
      </form>
    </main>
  );
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

  const [stateName, setStateName] = useState("");
  const [district, setDistrict] = useState("");
  const [contactNumber, setContactNumber] = useState("");

  const [
    primaryDepartment,
    setPrimaryDepartment,
  ] =
    useState("");

  const [
    additionalDepartments,
    setAdditionalDepartments,
  ] =
    useState<string[]>([]);

  const [additionalCharge, setAdditionalCharge] =
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
        !displayName.trim()
      ) {
        return;
      }

      const others = additionalDepartments.filter(
        (department) => department !== primaryDepartment,
      );

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
                  stateName: stateName || undefined,
                  district: district.trim() || undefined,
                  contactNumber: contactNumber.trim() || undefined,
                  preferredLanguage,
                  defaultScope,
                  primaryDepartment:
                    primaryDepartment || null,
                  additionalDepartments: others,
                  additionalChargeDepartments:
                    additionalCharge.filter((department) =>
                      others.includes(department),
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
                      {profile.departments.length === 0
                        ? "No department"
                        : profile.departments.length === 1
                          ? profile.departments[0]
                          : `${profile.departments[0]} +${profile.departments.length - 1} more`}
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

          <div className="onboarding-grid">
            <label>
              State or Union Territory
              <select
                value={stateName}
                onChange={(event) => setStateName(event.target.value)}
              >
                <option value="">Not specified</option>
                {INDIA_STATES_AND_UTS.map((state) => (
                  <option key={state} value={state}>{state}</option>
                ))}
              </select>
            </label>
            <label>
              District
              <input
                value={district}
                onChange={(event) => setDistrict(event.target.value)}
                placeholder="Optional"
              />
            </label>
          </div>

          <label>
            Contact number <span className="field-optional">Optional</span>
            <input
              type="tel"
              value={contactNumber}
              onChange={(event) => setContactNumber(event.target.value)}
              placeholder="For this workspace profile"
            />
            <span className="field-help">
              This is profile information only; it is not used to sign in.
            </span>
          </label>

          <label>
            Substantive (primary) department
            <select
              value={
                primaryDepartment
              }
              onChange={(
                event,
              ) => {
                const next = event.target.value;
                setPrimaryDepartment(next);
                setAdditionalDepartments((current) =>
                  current.filter((department) => department !== next),
                );
                setAdditionalCharge((current) =>
                  current.filter((department) => department !== next),
                );
              }}
            >
              <option value="">None</option>
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

          <div className="profile-field-block">
            <div className="profile-field-label">Other departments</div>
            <span className="field-help">
              Select departments you work with, and mark{" "}
              <strong>Addl. charge</strong> for any held as additional charge.
              Leave everything empty to search all departments.
            </span>
            <DepartmentChecklist
              departments={departments}
              primaryDepartment={primaryDepartment}
              selected={additionalDepartments}
              onChange={setAdditionalDepartments}
              charged={additionalCharge}
              onChargedChange={setAdditionalCharge}
            />
          </div>

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
              !displayName.trim()
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
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [themeReady, setThemeReady] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);

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

  const [archivedConversations, setArchivedConversations] = useState<ConversationSummary[]>([]);
  const [historyView, setHistoryView] = useState<"recent" | "archived">("recent");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; right: number } | null>(null);
  const [renameTarget, setRenameTarget] = useState<ConversationSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [historySearch, setHistorySearch] = useState("");
  const [collapsedDateGroups, setCollapsedDateGroups] = useState<Set<string>>(() => new Set());
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);

  const [
    selectedConversationId,
    setSelectedConversationId,
  ] =
    useState<
      string | null
    >(null);

  const [profileEditing, setProfileEditing] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [historyBusyId, setHistoryBusyId] = useState<string | null>(null);

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

  useEffect(() => {
    let initialTheme: "dark" | "light" = "dark";
    try {
      initialTheme = window.localStorage.getItem(THEME_STORAGE_KEY) === "light"
        ? "light"
        : "dark";
    } catch {
      // The workspace remains usable when browser storage is unavailable.
    }
    document.documentElement.dataset.theme = initialTheme;
    setTheme(initialTheme);
    setThemeReady(true);
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Keep the current appearance for this page even if persistence is blocked.
    }
  }, [theme, themeReady]);

  useEffect(() => {
    if (!openMenuId) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest(".history-menu-wrap")) {
        setOpenMenuId(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuId(null);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenuId]);

  const loadHistory =
    useCallback(
      async (
        userId: string,
        archived = false,
      ) => {
        const listUrl = (wantArchived: boolean) =>
          `/api/workspace/users/${encodeURIComponent(userId)}/conversations${wantArchived ? "?archived=true" : ""}`;

        if (archived) {
          const data = await jsonRequest<{
            conversations: ConversationSummary[];
          }>(listUrl(true));
          setArchivedConversations(data.conversations);
          return data.conversations;
        }

        // Load archived history alongside recent history so the Archived badge
        // shows the real count on page load instead of 0 until it is opened.
        const [recent, archivedList] = await Promise.all([
          jsonRequest<{ conversations: ConversationSummary[] }>(listUrl(false)),
          jsonRequest<{ conversations: ConversationSummary[] }>(listUrl(true))
            .catch(() => null),
        ]);

        setConversations(recent.conversations);
        if (archivedList) {
          setArchivedConversations(archivedList.conversations);
        }

        return [
          ...recent.conversations,
          ...(archivedList?.conversations ?? []),
        ];
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

        const loadedConversations = await loadHistory(
          active.id,
        );

        const sharedConversationId = new URLSearchParams(window.location.search).get("conversation");
        if (sharedConversationId && loadedConversations.some((item) => item.id === sharedConversationId)) {
          setSelectedConversationId(sharedConversationId);
        }
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

              const loadedConversations = await loadHistory(
                data.profile.id,
              );

              const sharedConversationId = new URLSearchParams(window.location.search).get("conversation");
              if (sharedConversationId && loadedConversations.some((item) => item.id === sharedConversationId)) {
                setSelectedConversationId(sharedConversationId);
              }

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

                const loadedConversations = await loadHistory(
                  migrated.id,
                );

                const sharedConversationId = new URLSearchParams(window.location.search).get("conversation");
                if (sharedConversationId && loadedConversations.some((item) => item.id === sharedConversationId)) {
                  setSelectedConversationId(sharedConversationId);
                }

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
    setProfileEditing(false);
    setHistoryView("recent");
    setOpenMenuId(null);
    setHistorySearch("");
    setSelectedConversationId(
      null,
    );
    const url = new URL(window.location.href);
    url.searchParams.delete("conversation");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);

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
      setProfileEditing(false);

      setConversations(
        [],
      );
      setArchivedConversations([]);
      setHistoryView("recent");

      setSelectedConversationId(
        null,
      );
      const url = new URL(window.location.href);
      url.searchParams.delete("conversation");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);

      setChatSessionKey(
        (current) =>
          current + 1,
      );

      setMode(
        "ask",
      );

      await loadDevProfiles();
    };

  const saveProfile = async (input: {
    displayName: string;
    designation?: string;
    stateName?: string;
    district?: string;
    contactNumber?: string;
    preferredLanguage: "en" | "hi";
    defaultScope: "my_departments" | "all_departments";
    primaryDepartment: string | null;
    additionalDepartments: string[];
    additionalChargeDepartments: string[];
  }) => {
    if (!profile || profileSaving) return;
    setProfileSaving(true);
    setError(null);
    try {
      const updated = await jsonRequest<WorkspaceProfile>(
        `/api/workspace/users/${encodeURIComponent(profile.id)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      setProfile(updated);
      setProfileEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setProfileSaving(false);
    }
  };

  const persistConversationUpdate = async (
    conversation: ConversationSummary,
    patch: { title?: string; isPinned?: boolean; archived?: boolean },
  ) => {
    if (!profile || historyBusyId) return;
    setHistoryBusyId(conversation.id);
    setError(null);
    try {
      const updated = await jsonRequest<ConversationSummary>(
        `/api/workspace/users/${encodeURIComponent(profile.id)}/conversations/${encodeURIComponent(conversation.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      setConversations((current) =>
        (updated.archived
          ? current.filter((item) => item.id !== updated.id)
          : [...current.filter((item) => item.id !== updated.id), updated])
          .sort((left, right) => Number(right.isPinned) - Number(left.isPinned)
            || right.updatedAt.localeCompare(left.updatedAt)),
      );
      setArchivedConversations((current) =>
        (updated.archived
          ? [...current.filter((item) => item.id !== updated.id), updated]
          : current.filter((item) => item.id !== updated.id))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      );
      return updated;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(
        message.includes("404:") && message.includes("PATCH")
          ? "The API server needs a restart to load chat pinning. Restart it, then try again."
          : message,
      );
    } finally {
      setHistoryBusyId(null);
    }
  };

  const togglePin = async (conversation: ConversationSummary) => {
    setOpenMenuId(null);
    await persistConversationUpdate(conversation, { isPinned: !conversation.isPinned });
  };

  const archiveConversation = async (conversation: ConversationSummary) => {
    setOpenMenuId(null);
    const updated = await persistConversationUpdate(conversation, { archived: true });
    if (updated && selectedConversationId === conversation.id) {
      setSelectedConversationId(null);
      setChatSessionKey((current) => current + 1);
      const url = new URL(window.location.href);
      url.searchParams.delete("conversation");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  };

  const restoreConversation = async (conversation: ConversationSummary) => {
    setOpenMenuId(null);
    await persistConversationUpdate(conversation, { archived: false });
  };

  // Opening an archived conversation only views it. It stays archived until the
  // user explicitly restores it (previously a click silently un-archived it,
  // which made the archive count drop unexpectedly).
  const openArchivedConversation = (conversation: ConversationSummary) => {
    setOpenMenuId(null);
    setProfileEditing(false);
    setSelectedConversationId(conversation.id);
    setChatSessionKey((current) => current + 1);
    setMode("ask");
    const url = new URL(window.location.href);
    url.searchParams.set("conversation", conversation.id);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const beginRename = (conversation: ConversationSummary) => {
    setOpenMenuId(null);
    setRenameTarget(conversation);
    setRenameDraft(conversation.title);
  };

  const shareConversation = async (conversation: ConversationSummary) => {
    setOpenMenuId(null);
    const url = new URL(window.location.href);
    url.searchParams.set("conversation", conversation.id);
    const shareUrl = url.toString();
    try {
      if (navigator.share) {
        await navigator.share({
          title: conversation.title,
          text: "Open this Shasanadesh workspace conversation.",
          url: shareUrl,
        });
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        window.prompt("Copy this workspace link", shareUrl);
      }
      setHistoryNotice("Workspace link copied. Access requires the same workspace session.");
      window.setTimeout(() => setHistoryNotice(null), 4500);
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setError("Could not share this conversation. Check clipboard permissions and try again.");
    }
  };

  const removeConversation = async (conversation: ConversationSummary) => {
    if (!profile || historyBusyId) return;
    const confirmed = window.confirm(
      `Delete “${conversation.title}”? This permanently removes its saved messages and sources.`,
    );
    if (!confirmed) return;

    setHistoryBusyId(conversation.id);
    setError(null);
    try {
      await jsonRequest<{ ok: boolean }>(
        `/api/workspace/users/${encodeURIComponent(profile.id)}/conversations/${encodeURIComponent(conversation.id)}`,
        { method: "DELETE" },
      );
      setConversations((current) =>
        current.filter((item) => item.id !== conversation.id),
      );
      setArchivedConversations((current) =>
        current.filter((item) => item.id !== conversation.id),
      );
      setOpenMenuId(null);
      if (selectedConversationId === conversation.id) {
        setSelectedConversationId(null);
        setChatSessionKey((current) => current + 1);
        setMode("ask");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setHistoryBusyId(null);
    }
  };

  const renderConversationRows = (
    items: ConversationSummary[],
    archived = false,
  ) => items.map((conversation) => {
    const active = selectedConversationId === conversation.id;
    const busy = historyBusyId === conversation.id;
    return (
      <div className={`history-row${active ? " active" : ""}${openMenuId === conversation.id ? " menu-open" : ""}`} key={conversation.id}>
        <button
          type="button"
          className="history-item"
          aria-current={active ? "page" : undefined}
          onClick={() => {
            if (archived) {
              void openArchivedConversation(conversation);
              return;
            }
            setProfileEditing(false);
            setHistoryView("recent");
            setSelectedConversationId(conversation.id);
            setChatSessionKey((current) => current + 1);
            setMode("ask");
            const url = new URL(window.location.href);
            url.searchParams.set("conversation", conversation.id);
            window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
          }}
        >
          <span>{conversation.title}</span>
        </button>
        <div className="history-actions">
          {archived ? (
            <button
              type="button"
              className="history-action restore-action"
              title="Restore conversation"
              aria-label={`Restore ${conversation.title}`}
              disabled={busy || historyBusyId !== null}
              onClick={() => void restoreConversation(conversation)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" /><path d="M4 4v4.5h4.5M12 8v4l3 2" /></svg>
            </button>
          ) : (
            <button
              type="button"
              className={conversation.isPinned ? "history-action pin-action is-pinned" : "history-action pin-action"}
              title={conversation.isPinned ? "Unpin conversation" : "Pin conversation"}
              aria-label={conversation.isPinned ? `Unpin ${conversation.title}` : `Pin ${conversation.title}`}
              disabled={busy || historyBusyId !== null}
              onClick={() => void togglePin(conversation)}
            >
              <svg className={conversation.isPinned ? "pin-icon pinned" : "pin-icon"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M16 9V4h1V2H7v2h1v5l-2 2v2h5v7l1 2 1-2v-7h5v-2l-2-2Z" />
              </svg>
            </button>
          )}
          <div className="history-menu-wrap">
            <button
              type="button"
              className="history-action more-action"
              aria-label={`More options for ${conversation.title}`}
              aria-haspopup="menu"
              aria-expanded={openMenuId === conversation.id}
              title="More options"
              disabled={busy || historyBusyId !== null}
              onClick={(event) => {
                if (openMenuId === conversation.id) {
                  setOpenMenuId(null);
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                setMenuPosition({
                  top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 236)),
                  right: Math.max(8, window.innerWidth - rect.right),
                });
                setOpenMenuId(conversation.id);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>
            </button>
            {openMenuId === conversation.id ? (
              <div className="history-menu" role="menu" aria-label={`Options for ${conversation.title}`} style={menuPosition ?? undefined}>
                {!archived ? (
                  <button type="button" role="menuitem" onClick={() => void shareConversation(conversation)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5M5 13v6h14v-6" /></svg>
                    Share
                  </button>
                ) : null}
                <button type="button" role="menuitem" onClick={() => beginRename(conversation)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.5-.8 4.3 4.3-.8L19.8 7.7a2.1 2.1 0 0 0-3-3L4 16.5Z" /><path d="m14.8 6.7 3 3" /></svg>
                  Rename
                </button>
                {!archived ? (
                  <button type="button" role="menuitem" onClick={() => void togglePin(conversation)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 9V4h1V2H7v2h1v5l-2 2v2h5v7l1 2 1-2v-7h5v-2l-2-2Z" /></svg>
                    {conversation.isPinned ? "Unpin" : "Pin"}
                  </button>
                ) : (
                  <button type="button" role="menuitem" onClick={() => void restoreConversation(conversation)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" /><path d="M4 4v4.5h4.5M12 8v4l3 2" /></svg>
                    Restore from archive
                  </button>
                )}
                {!archived ? (
                  <button type="button" role="menuitem" onClick={() => void archiveConversation(conversation)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6" /></svg>
                    Archive
                  </button>
                ) : null}
                <div className="history-menu-divider" />
                <button type="button" className="history-menu-danger" role="menuitem" onClick={() => void removeConversation(conversation)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3" /></svg>
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  });

  const normalizedHistorySearch = historySearch.trim().toLocaleLowerCase();
  const matchesHistorySearch = (conversation: ConversationSummary) =>
    !normalizedHistorySearch || conversation.title.toLocaleLowerCase().includes(normalizedHistorySearch);
  const visibleConversations = conversations.filter(matchesHistorySearch);
  const visibleArchivedConversations = archivedConversations.filter(matchesHistorySearch);
  const visiblePinnedConversations = visibleConversations.filter((conversation) => conversation.isPinned);
  const visibleRecentConversations = visibleConversations.filter((conversation) => !conversation.isPinned);

  const renderDateGroupedHistory = (items: ConversationSummary[], archived = false) =>
    conversationDateGroups(items).map((group) => {
      const collapseKey = `${archived ? "archived" : "recent"}:${group.key}`;
      const collapsed = collapsedDateGroups.has(collapseKey);
      const groupId = `history-date-${collapseKey}`;
      return (
        <section className="history-date-section" key={collapseKey}>
          <button
            type="button"
            className="history-date-heading"
            aria-expanded={!collapsed}
            aria-controls={groupId}
            onClick={() => setCollapsedDateGroups((current) => {
              const next = new Set(current);
              if (next.has(collapseKey)) next.delete(collapseKey);
              else next.add(collapseKey);
              return next;
            })}
          >
            <span>{group.label}</span>
            <svg className={collapsed ? "collapsed" : ""} viewBox="0 0 20 20" aria-hidden="true">
              <path d="m5 7.5 5 5 5-5" />
            </svg>
            <small className="history-date-count">{group.conversations.length}</small>
          </button>
          <div id={groupId} className="history-date-items" role="group" aria-label={`${group.label} conversations`} hidden={collapsed}>
            {!collapsed ? renderConversationRows(group.conversations, archived) : null}
          </div>
        </section>
      );
    });

  const selectedArchivedConversation =
    archivedConversations.find(
      (conversation) => conversation.id === selectedConversationId,
    ) ?? null;

  if (loading) {
    return (
      <main className="onboarding-shell">
        <div className="muted">
          Loading workspace…
        </div>
      </main>
    );
  }

  if (!profile && error) {
    // The first load failed (usually the API or database is not running).
    // Showing onboarding here would look like the profiles had disappeared.
    const apiDown = /^50[23]\b|fetch failed|ECONNREFUSED/i.test(error);
    return (
      <main className="onboarding-shell">
        <div className="onboarding-card startup-error" role="alert">
          <div className="eyebrow">Shasanadesh workspace</div>
          <h1>Can&apos;t reach the server</h1>
          <p className="onboarding-copy">
            {apiDown
              ? "The answer API or database is not running. Start all services with npm run dev:all, then retry."
              : error}
          </p>
          <button
            type="button"
            className="onboarding-submit"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
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
    <div className={sidebarHidden ? "workspace-layout sidebar-hidden" : "workspace-layout"}>
      <aside className="history-sidebar" id="workspace-history-sidebar">
        <div className="history-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></svg>
          <input
            type="text"
            aria-label="Search conversations"
            placeholder="Search conversations"
            value={historySearch}
            onChange={(event) => setHistorySearch(event.target.value)}
          />
          {historySearch ? (
            <button type="button" aria-label="Clear conversation search" onClick={() => setHistorySearch("")}>×</button>
          ) : null}
        </div>

        <button
          type="button"
          className="history-profile history-profile-button"
          onClick={() => {
            setError(null);
            setProfileEditing(true);
          }}
          aria-label="Edit profile and departments"
        >
          <div className="history-avatar">
            {profile.displayName
              .trim()
              .slice(0, 1)
              .toUpperCase()}
          </div>

          <div>
            <strong>
              {profile.displayName.trim().split(/\s+/)[0] || profile.displayName}
            </strong>

            <div className="history-designation">
              {profile.designation ??
                "Government officer"}
            </div>
          </div>
          <span className="profile-edit-mark" aria-hidden="true">✎</span>
        </button>

        <div className="history-scope">
          <div className="section-label">
            Working scope
          </div>

          {profile.departments.length === 0 ? (
            <span className="scope-all">
              No department set · searching all departments
            </span>
          ) : (
            profile.departments.map((department) => {
              const charge = (profile.additionalChargeDepartments ?? []).includes(department);
              const primary = department === profile.primaryDepartment;
              return (
                <span
                  key={department}
                  className={primary ? "scope-department scope-primary" : "scope-department"}
                >
                  {department}
                  {charge ? <em className="scope-tag">Addl. charge</em> : null}
                </span>
              );
            })
          )}
        </div>

        <button
          type="button"
          className="switch-profile-button"
          onClick={() =>
            void switchProfile()
          }
        >
          Switch profile
        </button>

        <button
          type="button"
          className={historyView === "archived" ? "archive-view-button active" : "archive-view-button"}
          aria-current={historyView === "archived" ? "page" : undefined}
          onClick={() => {
            const nextView = historyView === "archived" ? "recent" : "archived";
            setHistoryView(nextView);
            setOpenMenuId(null);
            if (nextView === "archived") void loadHistory(profile.id, true);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6" /></svg>
          <span>{historyView === "archived" ? "Back to chats" : "Archived"}</span>
          <small className="history-count-badge">{archivedConversations.length}</small>
        </button>

        {historyView === "archived" ? (
          <>
            <div className="history-heading history-heading-counted">
              <span>Archived conversations</span>
              <small className="history-count-badge">{visibleArchivedConversations.length}</small>
            </div>
            <nav className="history-list" aria-label="Archived conversations">
              {visibleArchivedConversations.length > 0
                ? renderDateGroupedHistory(visibleArchivedConversations, true)
                : <div className="history-empty">
                    {normalizedHistorySearch ? "No archived conversations match your search." : "Archived conversations will appear here."}
                  </div>}
            </nav>
          </>
        ) : (
          <>
            {visiblePinnedConversations.length > 0 || !normalizedHistorySearch ? (
              <>
                <button
                  type="button"
                  className="history-heading history-section-toggle"
                  aria-expanded={!pinnedCollapsed}
                  aria-controls="pinned-history-items"
                  onClick={() => setPinnedCollapsed((collapsed) => !collapsed)}
                >
                  <svg className={pinnedCollapsed ? "collapsed" : ""} viewBox="0 0 20 20" aria-hidden="true">
                    <path d="m5 7.5 5 5 5-5" />
                  </svg>
                  <span>Pinned</span>
                  <small className="history-count-badge">{visiblePinnedConversations.length}</small>
                </button>
                <nav id="pinned-history-items" className="history-list" aria-label="Pinned conversations" hidden={pinnedCollapsed}>
                  {visiblePinnedConversations.length > 0
                    ? renderConversationRows(visiblePinnedConversations)
                    : <div className="history-empty">Pin a conversation to keep it here.</div>}
                </nav>
              </>
            ) : null}

            {visibleRecentConversations.length > 0 || !normalizedHistorySearch ? (
              <>
                <div className="history-heading">Recent</div>
                <nav className="history-list" aria-label="Recent conversations">
                  {visibleRecentConversations.length > 0
                    ? renderDateGroupedHistory(visibleRecentConversations)
                    : conversations.length === 0
                      ? <div className="history-empty">Your saved conversations will appear here.</div>
                      : <div className="history-empty">All conversations are pinned.</div>}
                </nav>
              </>
            ) : null}

            {normalizedHistorySearch && visibleConversations.length === 0 ? (
              <div className="history-empty search-empty">No conversations match your search.</div>
            ) : null}
          </>
        )}

        <div className="history-footer">
          {historyNotice ? <div className="history-notice" role="status">{historyNotice}</div> : null}
          HttpOnly development
          session
        </div>
      </aside>

      <div className="workspace-main">
        {error ? (
          <div className="workspace-error">
            {error}
          </div>
        ) : null}

        {profileEditing ? (
          <ProfileEditor
            key={profile.id}
            profile={profile}
            departments={departments}
            busy={profileSaving}
            onCancel={() => {
              setError(null);
              setProfileEditing(false);
            }}
            onSave={saveProfile}
          />
        ) : (
          <>
          <div className="workspace-toolbar">
            <button
              type="button"
              className="sidebar-toggle"
              aria-controls="workspace-history-sidebar"
              aria-expanded={!sidebarHidden}
              aria-label={sidebarHidden ? "Show history panel" : "Hide history panel"}
              title={sidebarHidden ? "Show history panel" : "Hide history panel"}
              onClick={() => setSidebarHidden((hidden) => !hidden)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M9 4v16" />
                {sidebarHidden
                  ? <path d="m13 9 3 3-3 3" />
                  : <path d="m16 9-3 3 3 3" />}
              </svg>
            </button>

            <div className="workspace-switch">
              <button
                type="button"
                className={
                  mode === "ask"
                    ? "workspace-switch-button active"
                    : "workspace-switch-button"
                }
                onClick={() => setMode("ask")}
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
                onClick={() => setMode("search")}
              >
                Search
              </button>
            </div>

            <div className="theme-control">
              {theme === "light" ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M20.6 15.3A8.5 8.5 0 0 1 8.7 3.4 8.6 8.6 0 1 0 20.6 15.3Z" />
                </svg>
              )}
              <button
                type="button"
                role="switch"
                aria-checked={theme === "dark"}
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
                title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
                className="appearance-switch"
                onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              >
                <span className="appearance-switch-thumb" />
              </button>
            </div>
          </div>

        {mode === "ask" ? (
          <ChatApp
            key={`${chatSessionKey}-${selectedConversationId ?? "new"}`}
            workspaceUserId={
              profile.id
            }
            conversationId={
              selectedConversationId
            }
            preferredLanguage={profile.preferredLanguage}
            archived={selectedArchivedConversation !== null}
            onRestoreArchived={
              selectedArchivedConversation
                ? () => void restoreConversation(selectedArchivedConversation)
                : undefined
            }
            onHistoryChanged={() =>
              void refreshHistory()
            }
          />
        ) : (
          <SearchApp />
        )}
          </>
        )}

        {renameTarget ? (
          <div className="rename-dialog-backdrop" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRenameTarget(null);
          }}>
            <form
              className="rename-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="rename-dialog-title"
              onSubmit={(event) => {
                event.preventDefault();
                const title = renameDraft.trim();
                if (!title) return;
                void (async () => {
                  const updated = await persistConversationUpdate(renameTarget, { title });
                  if (updated) setRenameTarget(null);
                })();
              }}
            >
              <h2 id="rename-dialog-title">Rename conversation</h2>
              <label htmlFor="conversation-rename-input">Conversation name</label>
              <input
                id="conversation-rename-input"
                autoFocus
                maxLength={200}
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
              />
              <div className="rename-dialog-actions">
                <button type="button" onClick={() => setRenameTarget(null)}>Cancel</button>
                <button type="submit" disabled={!renameDraft.trim() || historyBusyId !== null}>Save</button>
              </div>
            </form>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        className="new-chat-fab"
        aria-label="New chat"
        title="New chat"
        onClick={newChat}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  );
}
