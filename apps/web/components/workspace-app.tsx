"use client";

import {
  FormEvent,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
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
  /** ADR-066: when and why it was archived ("inactive" = automatic). */
  archivedAt?: string | null;
  archivedReason?: "manual" | "inactive" | null;
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

/**
 * Archives (ADR-066): month sections ("September 2026"), each with the days
 * the conversations were last active. Items arrive newest first.
 */
function archiveMonthGroups(items: ConversationSummary[]) {
  const months = new Map<string, Map<string, ConversationSummary[]>>();
  for (const conversation of items) {
    const day = appDayKey(conversation.updatedAt);
    const month = day.slice(0, 7);
    const days = months.get(month) ?? new Map<string, ConversationSummary[]>();
    days.set(day, [...(days.get(day) ?? []), conversation]);
    months.set(month, days);
  }
  return [...months.entries()].map(([key, days]) => {
    const [year, month] = key.split("-").map(Number);
    const label = new Date(Date.UTC(year, month - 1, 15)).toLocaleDateString("en-IN", {
      timeZone: "UTC",
      month: "long",
      year: "numeric",
    });
    return {
      key,
      label,
      count: [...days.values()].reduce((total, list) => total + list.length, 0),
      days: [...days.entries()].map(([dayKey, conversations]) => ({
        key: dayKey,
        label: formatDayKey(dayKey, true),
        conversations,
      })),
    };
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

// English names and common spellings of the stored (Hindi) department names,
// from datasets/departments.json via /api/workspace/departments.
// `choice` is the picker entry a name belongs to: "Agriculture" (from another
// source) and "कृषि विभाग" (the portal) are one department.
type DepartmentLabels = Record<string, { hi?: string; en: string; aliases: string[]; choice?: string }>;

function departmentDisplay(
  name: string,
  labels: DepartmentLabels,
  language: "hi" | "en",
): { main: string; sub: string | null } {
  const label = labels[name];
  if (!label) return { main: name, sub: null };
  const hi = label.hi ?? name;
  return language === "en" ? { main: label.en, sub: hi } : { main: hi, sub: label.en };
}

/** The picker entry for a stored name, and a list with duplicates folded together. */
function departmentChoice(name: string, labels: DepartmentLabels): string {
  return labels[name]?.choice ?? name;
}
function departmentChoiceList(names: string[], labels: DepartmentLabels): string[] {
  return [...new Set(names.map((name) => departmentChoice(name, labels)))];
}
const DepartmentLabelsContext = createContext<DepartmentLabels>({});

// Which name comes first wherever departments are listed: the portal's Hindi
// name or the English one. One switch for the whole app, remembered in the
// browser (DEPARTMENT_NAMES_STORAGE_KEY).
type DepartmentNameLanguage = "hi" | "en";
const DEPARTMENT_NAMES_STORAGE_KEY = "shasanadesh.departmentNames";
const DepartmentNameLanguageContext = createContext<{
  language: DepartmentNameLanguage;
  setLanguage: (next: DepartmentNameLanguage) => void;
}>({ language: "en", setLanguage: () => {} });

function useDepartmentNames() {
  const labels = useContext(DepartmentLabelsContext);
  const { language, setLanguage } = useContext(DepartmentNameLanguageContext);
  /** The name shown first. */
  const main = (name: string) => departmentDisplay(name, labels, language).main;
  /** The other language, shown smaller (null when the registry has no entry). */
  const sub = (name: string) => departmentDisplay(name, labels, language).sub;
  const option = (name: string) => {
    const other = sub(name);
    return other ? `${main(name)} — ${other}` : main(name);
  };
  /** English order in English; the portal's order in Hindi. */
  const sort = (names: string[]) =>
    language === "en"
      ? [...names].sort((a, b) => main(a).localeCompare(main(b), "en"))
      : names;
  const choice = (name: string) => departmentChoice(name, labels);
  const choiceList = (names: string[]) => departmentChoiceList(names, labels);
  return { labels, language, setLanguage, main, sub, option, sort, choice, choiceList };
}

/** हिन्दी / English switch for department names; sits beside each department list. */
function DepartmentNameToggle() {
  const { language, setLanguage } = useContext(DepartmentNameLanguageContext);
  return (
    <span className="dept-lang-toggle" role="group" aria-label="Department names in">
      {([["hi", "हिन्दी"], ["en", "English"]] as const).map(([value, label]) => (
        <button
          key={value}
          type="button"
          className={language === value ? "active" : ""}
          aria-pressed={language === value}
          title={value === "en" ? "Show department names in English" : "विभागों के नाम हिन्दी में दिखाएँ"}
          onClick={() => setLanguage(value)}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

function searchKey(text: string): string {
  return text.replace(/[\u200c\u200d]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function departmentMatches(department: string, labels: DepartmentLabels, query: string): boolean {
  const key = searchKey(query);
  if (!key) return true;
  const label = labels[department];
  return [department, label?.hi ?? "", label?.en ?? "", ...(label?.aliases ?? [])].some((name) =>
    searchKey(name).includes(key),
  );
}

// One list for all of an officer's departments. Every ticked department is
// searched (nothing else depends on which one is "main"); none ticked =
// search all departments. The main (substantive) posting is derived: the
// first ticked department not held as additional charge, unless the officer
// marks another as Main. It only orders and highlights the profile.
const MAX_DEPARTMENTS = 12;

function nextMain(selected: string[], charged: string[], except?: string): string {
  return selected.find((item) => item !== except && !charged.includes(item)) ?? "";
}

function DepartmentChecklist({
  departments,
  selected,
  onChange,
  charged,
  onChargedChange,
  primary,
  onPrimaryChange,
}: {
  departments: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  charged: string[];
  onChargedChange: (next: string[]) => void;
  primary: string;
  onPrimaryChange: (next: string) => void;
}) {
  const names = useDepartmentNames();
  const labels = names.labels;
  const [query, setQuery] = useState("");
  const all = names.sort(departments);
  // Ticked departments stay in view while searching, so they can be unticked.
  const shown = all.filter(
    (department) =>
      selected.includes(department) ||
      departmentMatches(department, labels, query),
  );

  if (all.length === 0) {
    return (
      <div className="field-help">
        No departments are available yet.
      </div>
    );
  }

  const add = (department: string) => {
    if (selected.includes(department) || selected.length >= MAX_DEPARTMENTS) return;
    onChange([...selected, department]);
    if (!primary) onPrimaryChange(department);
  };

  const remove = (department: string) => {
    const rest = selected.filter((item) => item !== department);
    const restCharged = charged.filter((item) => item !== department);
    onChange(rest);
    onChargedChange(restCharged);
    if (department === primary) onPrimaryChange(nextMain(rest, restCharged));
  };

  const toggle = (department: string) =>
    selected.includes(department) ? remove(department) : add(department);

  const toggleCharge = (department: string) => {
    if (charged.includes(department)) {
      const next = charged.filter((item) => item !== department);
      onChargedChange(next);
      if (!primary) onPrimaryChange(department);
      return;
    }
    const next = [...charged, department];
    onChargedChange(next);
    // The substantive posting is never additional charge.
    if (department === primary) onPrimaryChange(nextMain(selected, next, department));
  };

  const makeMain = (department: string) => {
    onPrimaryChange(department);
    onChargedChange(charged.filter((item) => item !== department));
  };

  // Main first, then in the order they were ticked.
  const chips = [...selected].sort((a, b) => Number(b === primary) - Number(a === primary));

  return (
    <div className="department-picker">
      {chips.length ? (
        <div className="department-chips" aria-label="Selected departments">
          {chips.map((department) => (
            <span
              key={department}
              className={department === primary ? "department-chip main" : "department-chip"}
              title={names.sub(department) ?? undefined}
            >
              {department === primary ? <em>Main</em> : null}
              {charged.includes(department) ? <em className="charge">Addl.</em> : null}
              {names.main(department)}
              <button
                type="button"
                aria-label={`Remove ${names.main(department)}`}
                onClick={() => remove(department)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="field-help department-none">
          No department ticked: questions search all departments.
        </div>
      )}
      <div className="department-search-row">
        <input
          type="search"
          className="department-search"
          placeholder="Search department (Hindi or English, e.g. कृषि, revenue, pwd)"
          aria-label="Search departments"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              // Enter ticks the only match instead of submitting the form.
              event.preventDefault();
              const matches = shown.filter((department) => !selected.includes(department));
              if (matches.length === 1) {
                add(matches[0]);
                setQuery("");
              }
            }
          }}
        />
        <DepartmentNameToggle />
        <span className="department-count">
          {selected.length}/{MAX_DEPARTMENTS} selected
        </span>
      </div>
      <div className="department-checklist" aria-label="Departments">
        {shown.length === selected.length && query.trim() ? (
          <div className="field-help department-no-match">
            No department matches “{query.trim()}”.
          </div>
        ) : null}
        {shown.map((department) => {
          const isSelected = selected.includes(department);
          const isCharged = isSelected && charged.includes(department);
          const isMain = isSelected && department === primary;

          return (
            <div className={isSelected ? "department-option-row selected" : "department-option-row"} key={department}>
              <label className="department-option">
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={!isSelected && selected.length >= MAX_DEPARTMENTS}
                  onChange={() => toggle(department)}
                />
                <span className="department-name">
                  {names.main(department)}
                  {names.sub(department) ? <small>{names.sub(department)}</small> : null}
                </span>
              </label>
              {isSelected ? (
                <span className="department-row-actions">
                  <button
                    type="button"
                    className={isMain ? "charge-toggle main active" : "charge-toggle main"}
                    aria-pressed={isMain}
                    title="Your substantive posting (shown first in your profile)"
                    onClick={() => makeMain(department)}
                  >
                    Main
                  </button>
                  <button
                    type="button"
                    className={isCharged ? "charge-toggle active" : "charge-toggle"}
                    aria-pressed={isCharged}
                    title="Mark if you hold this department as additional charge"
                    onClick={() => toggleCharge(department)}
                  >
                    Addl. charge
                  </button>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// States/UTs and districts from the Local Government Directory (LGD), via
// /api/workspace/places. The server stores LGD codes beside the names, so a
// district officer's profile survives renames and matches other systems.
interface PlaceDistrict {
  code: number;
  name: string;
  hi: string | null;
  aliases: string[];
}
interface PlaceState {
  code: number;
  name: string;
  local: string | null;
  districts: PlaceDistrict[];
}
const PlacesContext = createContext<PlaceState[]>([]);
const OTHER_STATE = "Central Government / Other";

function placeKey(text: string): string {
  return text.toLocaleLowerCase("en").replace(/[‌‍]/g, "").replace(/[.,()'-]/g, " ").replace(/\s+/g, "");
}

interface SearchOption {
  value: string;
  label: string;
  sub?: string | null;
  keywords?: string[];
}

/**
 * Search-and-pick for one value from a list (our own control). Type any
 * spelling the option knows (Hindi, former names); arrow keys + Enter, or
 * click. A stored value that is not in the list is still shown.
 */
function SearchSelect({
  label,
  optional,
  value,
  onChange,
  options,
  noneLabel,
  disabled,
  disabledHint,
  searchPlaceholder,
}: {
  label: string;
  optional?: boolean;
  value: string;
  onChange: (next: string) => void;
  options: SearchOption[];
  noneLabel: string;
  disabled?: boolean;
  disabledHint?: string;
  searchPlaceholder: string;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const wanted = placeKey(query);
  const matches = wanted
    ? options.filter((option) =>
        [option.label, option.sub ?? "", ...(option.keywords ?? [])].some((text) => placeKey(text).includes(wanted)),
      )
    : options;
  const list: Array<SearchOption | null> = wanted ? matches : [null, ...matches];
  const selected = options.find((option) => option.value === value);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const pick = (next: string) => {
    onChange(next);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    inputRef.current?.focus();
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const openList = () => {
    if (disabled) return;
    const index = list.findIndex((option) => (option?.value ?? "") === value);
    setActive(index >= 0 ? index : 0);
    setOpen(true);
  };

  return (
    <div className="dept-combo" ref={rootRef}>
      <div className="profile-field-label label-row" id={`${id}-label`}>
        {label}
        {optional ? <span className="field-optional">optional</span> : null}
      </div>
      <button
        type="button"
        className={open ? "dept-combo-button open" : "dept-combo-button"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label`}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openList();
          }
        }}
      >
        {disabled && disabledHint ? (
          <span className="dept-combo-value placeholder">{disabledHint}</span>
        ) : value ? (
          <span className="dept-combo-value">
            <strong>{selected?.label ?? value}</strong>
            {selected ? (selected.sub ? <small>{selected.sub}</small> : null) : <small>Not in the LGD list</small>}
          </span>
        ) : (
          <span className="dept-combo-value placeholder">{noneLabel}</span>
        )}
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>

      {open ? (
        <div className="dept-combo-pop">
          <input
            ref={inputRef}
            type="search"
            className="department-search"
            placeholder={searchPlaceholder}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={list.length ? `${id}-opt-${active}` : undefined}
            aria-label={`Search ${label}`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((current) => Math.min(current + 1, list.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((current) => Math.max(current - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const option = list[Math.min(active, list.length - 1)];
                if (list.length) pick(option?.value ?? "");
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              } else if (event.key === "Tab") {
                close();
              }
            }}
          />
          <ul className="dept-combo-list" role="listbox" id={`${id}-list`} ref={listRef}>
            {list.length === 0 ? (
              <li className="dept-combo-empty">Nothing matches “{query.trim()}”.</li>
            ) : (
              list.map((option, index) => {
                const optionValue = option?.value ?? "";
                return (
                  <li
                    key={optionValue || "(none)"}
                    id={`${id}-opt-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={optionValue === value}
                    className={[
                      "dept-combo-option",
                      index === active ? "active" : "",
                      optionValue === value ? "selected" : "",
                    ].join(" ")}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(optionValue)}
                  >
                    {option ? (
                      <span className="department-name">
                        {option.label}
                        {option.sub ? <small>{option.sub}</small> : null}
                      </span>
                    ) : (
                      <span className="department-name none">{noneLabel}</span>
                    )}
                    {optionValue === value ? <span className="dept-combo-check" aria-hidden="true">✓</span> : null}
                  </li>
                );
              })
            )}
          </ul>
          <div className="dept-combo-foot">
            <span>{matches.length} of {options.length}</span>
            <span>Source: Local Government Directory</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** State/UT and district pickers (LGD); district lists only the chosen state's. */
function PlaceFields({
  stateName,
  district,
  onStateChange,
  onDistrictChange,
}: {
  stateName: string;
  district: string;
  onStateChange: (next: string) => void;
  onDistrictChange: (next: string) => void;
}) {
  const places = useContext(PlacesContext);
  const states = places.length
    ? places
    : INDIA_STATES_AND_UTS.filter((name) => name !== OTHER_STATE).map((name, index) => ({
        code: -index - 1,
        name,
        local: null,
        districts: [],
      }));
  const stateOptions: SearchOption[] = [
    ...[...states]
      .sort((a, b) => a.name.localeCompare(b.name, "en"))
      .map((state) => ({
        value: state.name,
        label: state.name,
        sub: state.local,
        // "UP", "MP", "J&K"-style initials.
        keywords: [
          state.name
            .split(/\s+/)
            .filter((word) => !/^(and|the|of)$/i.test(word))
            .map((word) => word[0])
            .join(""),
        ],
      })),
    { value: OTHER_STATE, label: OTHER_STATE, sub: "No district", keywords: ["central", "india", "other"] },
  ];
  const chosen = states.find((state) => placeKey(state.name) === placeKey(stateName));
  const districtOptions: SearchOption[] = (chosen?.districts ?? []).map((item) => ({
    value: item.name,
    label: item.name,
    sub: [item.hi, item.aliases.filter((alias) => /[A-Za-z]/.test(alias)).slice(0, 2).join(", ")]
      .filter(Boolean)
      .join(" · ") || null,
    keywords: [item.hi ?? "", ...item.aliases],
  }));
  // A stored name LGD knows under another spelling ("Allahabad") shows as the
  // LGD district (Prayagraj); it is saved that way on the next save.
  const districtValue =
    districtOptions.find((option) =>
      [option.label, ...(option.keywords ?? [])].some((name) => name && placeKey(name) === placeKey(district)),
    )?.value ?? district;
  const stateValue = chosen?.name ?? stateName;

  return (
    <>
      <SearchSelect
        label="State or Union Territory"
        value={stateValue}
        onChange={(next) => {
          onStateChange(next);
          const nextState = states.find((state) => state.name === next);
          if (!nextState?.districts.some((item) => item.name === districtValue)) onDistrictChange("");
        }}
        options={stateOptions}
        noneLabel="Not specified"
        searchPlaceholder="Search state or UT (e.g. Uttar Pradesh, UP)"
      />
      <SearchSelect
        label="District"
        optional
        value={districtValue}
        onChange={onDistrictChange}
        options={districtOptions}
        noneLabel="Not specified"
        disabled={!chosen || districtOptions.length === 0}
        disabledHint={stateValue === OTHER_STATE ? "Not applicable" : "Choose a state first"}
        searchPlaceholder="Search district (e.g. लखनऊ, Allahabad, Noida)"
      />
    </>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters.map((word) => Array.from(word)[0] ?? "").join("").toUpperCase() || "?";
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

interface DeletedProfileSummary {
  id: string;
  displayName: string;
  designation: string | null;
  conversationCount: number;
  deletedAt: string;
  purgeAfter: string;
}

/** "2 Nov 2026" for purge dates. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

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
  const departmentNames = useDepartmentNames();
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [designation, setDesignation] = useState(profile.designation ?? "");
  const [stateName, setStateName] = useState(profile.stateName ?? "");
  const [district, setDistrict] = useState(profile.district ?? "");
  const [contactNumber, setContactNumber] = useState(profile.contactNumber ?? "");
  // Saved names map to the picker's entries (a profile saved with
  // "Agriculture" shows as कृषि विभाग, ticked once).
  // No main posting saved: the first ticked department not held as
  // additional charge becomes the main one.
  const savedPrimary = profile.primaryDepartment
    ? departmentNames.choice(profile.primaryDepartment)
    : nextMain(
        departmentNames.choiceList(profile.departments),
        departmentNames.choiceList(profile.additionalChargeDepartments ?? []),
      );
  const [primaryDepartment, setPrimaryDepartment] = useState(savedPrimary);
  const [additionalCharge, setAdditionalCharge] = useState<string[]>(
    departmentNames.choiceList(profile.additionalChargeDepartments ?? []),
  );
  // All ticked departments, the main posting included.
  const [selectedDepartments, setSelectedDepartments] = useState(
    departmentNames.choiceList(profile.departments),
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
    const others = selectedDepartments.filter(
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
          <div className="section-label">Answers and search</div>
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
        </section>

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
            <PlaceFields
              stateName={stateName}
              district={district}
              onStateChange={setStateName}
              onDistrictChange={setDistrict}
            />
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
          <div className="section-label">My departments</div>
          <div className="profile-field-block">
            <p className="field-help">
              Tick up to 12 departments you work with; questions search all of
              them. The first one is your <strong>Main</strong> posting (change it
              on any ticked row) and <strong>Addl. charge</strong> marks a
              department held as additional charge. Tick none to search every
              department.
            </p>
            <DepartmentChecklist
              departments={departments}
              selected={selectedDepartments}
              onChange={setSelectedDepartments}
              charged={additionalCharge}
              onChargedChange={setAdditionalCharge}
              primary={primaryDepartment}
              onPrimaryChange={setPrimaryDepartment}
            />
          </div>
          <p className="field-help">
            {scopeHelp(
              primaryDepartment,
              selectedDepartments.filter(
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
  onCancel,
  currentName,
  currentId,
  maxProfiles = 5,
  onProfilesChanged,
}: {
  departments: string[];
  /**
   * A profile was deleted or restored: reload the list. signedOut is true when
   * the deleted profile was the one in use (its session has ended).
   */
  onProfilesChanged?: (change: { signedOut: boolean }) => void;
  /** Profile slots (the server refuses more). */
  maxProfiles?: number;
  profiles:
    WorkspaceProfile[];
  /** Switching profiles: go back to the profile in use without changing anything. */
  onCancel?: () => void;
  currentName?: string;
  currentId?: string;
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
  const departmentNames = useDepartmentNames();
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

  // All ticked departments, the main posting included.
  const [selectedDepartments, setSelectedDepartments] =
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

  // The profile list first; the form only when asked for (or no profiles yet).
  const [creating, setCreating] = useState(false);

  // Profile delete (ADR-079): "Manage" shows Delete on each tile and the
  // "Recently deleted" list (Restore / Delete now).
  const [managing, setManaging] = useState(false);
  const [deletedProfiles, setDeletedProfiles] = useState<DeletedProfileSummary[]>([]);
  const [restoreDays, setRestoreDays] = useState(30);
  const [confirming, setConfirming] = useState<
    | { kind: "delete"; id: string; name: string; conversations: number | null }
    | { kind: "purge"; id: string; name: string; conversations: number }
    | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadDeleted = useCallback(async () => {
    try {
      const data = await jsonRequest<{ profiles: DeletedProfileSummary[]; restoreDays?: number }>(
        "/api/session/dev-users/deleted",
      );
      setDeletedProfiles(data.profiles);
      if (data.restoreDays) setRestoreDays(data.restoreDays);
    } catch {
      setDeletedProfiles([]);
    }
  }, []);

  useEffect(() => {
    void loadDeleted();
  }, [loadDeleted]);

  const plainError = (caught: unknown) =>
    (caught instanceof Error ? caught.message : String(caught)).replace(/^\d{3}: /, "");

  const askDelete = async (item: WorkspaceProfile) => {
    setError(null);
    setNotice(null);
    setConfirming({ kind: "delete", id: item.id, name: item.displayName, conversations: null });
    try {
      const summary = await jsonRequest<{ conversationCount: number }>(
        `/api/session/dev-users/${item.id}/summary`,
      );
      setConfirming((open) =>
        open && open.kind === "delete" && open.id === item.id ? { ...open, conversations: summary.conversationCount } : open,
      );
    } catch {
      // The dialog still works without the count.
    }
  };

  const runConfirmed = async () => {
    if (!confirming || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (confirming.kind === "delete") {
        const result = await jsonRequest<{ purgeAfter: string; signedOut: boolean }>(
          `/api/session/dev-users/${confirming.id}`,
          { method: "DELETE" },
        );
        setNotice(`“${confirming.name}” deleted. You can restore it until ${shortDate(result.purgeAfter)}.`);
        onProfilesChanged?.({ signedOut: result.signedOut });
      } else {
        await jsonRequest(`/api/session/dev-users/${confirming.id}/permanent`, { method: "DELETE" });
        setNotice(`“${confirming.name}” and its conversations are deleted permanently.`);
      }
      setConfirming(null);
      await loadDeleted();
    } catch (caught) {
      setError(plainError(caught));
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (item: DeletedProfileSummary) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await jsonRequest(`/api/session/dev-users/${item.id}/restore`, { method: "POST" });
      setNotice(`“${item.displayName}” is back, with its conversations.`);
      onProfilesChanged?.({ signedOut: false });
      await loadDeleted();
    } catch (caught) {
      setError(plainError(caught));
    } finally {
      setBusy(false);
    }
  };

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

      const others = selectedDepartments.filter(
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

  // Escape steps back: from the new-profile form to the list, from the list
  // to the profile in use. Not while typing (Escape clears a search box).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (confirming) {
        if (!busy) setConfirming(null);
      } else if (managing) setManaging(false);
      else if (creating && profiles.length) setCreating(false);
      else onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, confirming, creating, managing, onCancel, profiles.length]);

  const freeSlots = Math.max(0, maxProfiles - profiles.length);
  const showForm = (creating && freeSlots > 0) || profiles.length === 0;
  const departmentText = departmentNames.main;
  const others = departments.length;

  return (
    <main className="onboarding-shell">
      {confirming ? (
        <div className="confirm-backdrop" onClick={() => !busy && setConfirming(null)}>
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-text"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="confirm-title">
              {confirming.kind === "delete" ? `Delete “${confirming.name}”?` : `Delete “${confirming.name}” permanently?`}
            </h2>
            <p id="confirm-text">
              {confirming.kind === "delete"
                ? `${
                    confirming.conversations === null
                      ? "Its conversations"
                      : confirming.conversations === 1
                        ? "Its 1 conversation"
                        : `Its ${confirming.conversations} conversations`
                  } will be deleted with it. You can restore it from Recently deleted for ${restoreDays} days.${
                    confirming.id === currentId ? " You are using this profile, so you will be signed out of it." : ""
                  }`
                : `Its ${confirming.conversations === 1 ? "1 conversation" : `${confirming.conversations} conversations`} will be deleted now. This cannot be undone.`}
            </p>
            <div className="confirm-actions">
              <button type="button" className="button-secondary" disabled={busy} onClick={() => setConfirming(null)} autoFocus>
                Cancel
              </button>
              <button type="button" className="danger-button" disabled={busy} onClick={() => void runConfirmed()}>
                {busy ? "Deleting…" : confirming.kind === "delete" ? "Delete profile" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="onboarding-card switcher-card">
        <header className="switcher-head">
          {onCancel ? (
            <button type="button" className="onboarding-back" onClick={onCancel}>
              ← Back{currentName ? ` to ${currentName}` : ""}
            </button>
          ) : null}
          <div className="eyebrow">Shasanadesh workspace</div>
          <h1>
            {showForm
              ? profiles.length ? "New profile" : "Create your profile"
              : onCancel ? "Switch profile" : "Choose your profile"}
          </h1>
          <p className="onboarding-copy">
            {showForm
              ? "Your departments decide which orders are searched first. You can change all of this later from your profile."
              : freeSlots
                ? "Pick a profile to continue with its departments and chat history, or set up a new one."
                : "Pick a profile to continue with its departments and chat history."}
          </p>
        </header>

        {!showForm ? (
          <section className="profile-picker" aria-label="Profiles">
            {/* Above the tiles, so it is seen on a phone without scrolling. */}
            {notice ? <div className="notice-box" role="status">{notice}</div> : null}
            {error ? <div className="error-box">{error}</div> : null}
            <div className="profile-grid">
              {profiles.map((item) => {
                const current = item.id === currentId;
                const folded = departmentNames.choiceList(item.departments);
                const shown = folded.slice(0, 2);
                const more = folded.length - shown.length;
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={[
                      "profile-tile",
                      current ? "current" : "",
                      managing ? "managing" : "",
                    ].filter(Boolean).join(" ")}
                    aria-current={current ? "true" : undefined}
                    aria-label={managing ? `Delete profile ${item.displayName}` : undefined}
                    disabled={busy}
                    onClick={() => {
                      if (managing) void askDelete(item);
                      else if (current && onCancel) onCancel();
                      else void loginExisting(item);
                    }}
                  >
                    <span className="profile-avatar" aria-hidden="true">
                      {initials(item.displayName)}
                    </span>
                    <span className="profile-tile-body">
                      <span className="profile-tile-name">
                        {item.displayName}
                        {current ? <em className="profile-current-badge">Current</em> : null}
                      </span>
                      <span className="profile-tile-role">
                        {item.designation ?? "Government officer"}
                        {item.district ? ` · ${item.district}` : ""}
                      </span>
                      <span className="profile-tile-depts">
                        {shown.length === 0 ? (
                          <span className="dept-chip muted">All departments</span>
                        ) : (
                          shown.map((name) => (
                            <span className="dept-chip" key={name} title={name}>
                              {departmentText(name)}
                            </span>
                          ))
                        )}
                        {more > 0 ? <span className="dept-chip muted">+{more}</span> : null}
                      </span>
                    </span>
                    <span className={managing ? "profile-tile-action danger" : "profile-tile-action"} aria-hidden="true">
                      {managing ? "Delete" : `${current ? "Continue" : "Use"} →`}
                    </span>
                  </button>
                );
              })}
              {/* Fixed slots: the first free one creates a profile, the rest are blank. */}
              {Array.from({ length: freeSlots }, (_, index) =>
                index === 0 && !managing ? (
                  <button
                    type="button"
                    key="new"
                    className="profile-tile profile-tile-new"
                    disabled={busy}
                    onClick={() => {
                      setError(null);
                      setCreating(true);
                    }}
                  >
                    <span className="profile-avatar new" aria-hidden="true">+</span>
                    <span className="profile-tile-body">
                      <span className="profile-tile-name">New profile</span>
                      <span className="profile-tile-role">Name, departments and language</span>
                    </span>
                  </button>
                ) : (
                  <div key={`empty-${index}`} className="profile-tile profile-tile-empty" aria-hidden="true">
                    <span className="profile-slot-mark">Slot {profiles.length + index + 1}</span>
                  </div>
                ),
              )}
            </div>
            <div className="profile-slot-row">
              <p className="profile-slot-note">
                {freeSlots === 0
                  ? `All ${maxProfiles} profile slots are in use.`
                  : `${profiles.length} of ${maxProfiles} profile slots used.`}
                {managing ? " Tap a profile to delete it." : ""}
              </p>
              {profiles.length || deletedProfiles.length ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setManaging((on) => !on);
                    setNotice(null);
                    setError(null);
                  }}
                >
                  {managing ? "Done" : deletedProfiles.length ? `Manage profiles · ${deletedProfiles.length} deleted` : "Manage profiles"}
                </button>
              ) : null}
            </div>
            {managing && deletedProfiles.length ? (
              <section className="deleted-profiles" aria-label="Recently deleted profiles">
                <h2>Recently deleted</h2>
                <p className="deleted-profiles-note">
                  Kept for {restoreDays} days, then deleted permanently with their conversations.
                </p>
                <ul>
                  {deletedProfiles.map((item) => (
                    <li key={item.id}>
                      <span className="profile-avatar muted" aria-hidden="true">{initials(item.displayName)}</span>
                      <span className="deleted-profile-body">
                        <span className="deleted-profile-name">{item.displayName}</span>
                        <span className="deleted-profile-meta">
                          {item.conversationCount === 1 ? "1 conversation" : `${item.conversationCount} conversations`}
                          {" · deleted permanently on "}
                          {shortDate(item.purgeAfter)}
                        </span>
                      </span>
                      <span className="deleted-profile-actions">
                        <button
                          type="button"
                          className="button-secondary"
                          disabled={busy || freeSlots === 0}
                          title={freeSlots === 0 ? "Delete another profile first: all slots are in use." : undefined}
                          onClick={() => void restore(item)}
                        >
                          Restore
                        </button>
                        <button
                          type="button"
                          className="link-button danger"
                          disabled={busy}
                          onClick={() =>
                            setConfirming({
                              kind: "purge",
                              id: item.id,
                              name: item.displayName,
                              conversations: item.conversationCount,
                            })
                          }
                        >
                          Delete now
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </section>
        ) : (
          <form className="onboarding-form profile-create" onSubmit={submit}>
            <fieldset className="form-section">
              <legend><span className="form-step">1</span> About you</legend>
              <div className="onboarding-grid">
                <label>
                  Name
                  <input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="Your name"
                    autoFocus
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
                <PlaceFields
                  stateName={stateName}
                  district={district}
                  onStateChange={setStateName}
                  onDistrictChange={setDistrict}
                />
                <label className="span-2">
                  <span className="label-row">Contact number <span className="field-optional">optional</span></span>
                  <input
                    type="tel"
                    value={contactNumber}
                    onChange={(event) => setContactNumber(event.target.value)}
                    placeholder="For this workspace profile"
                  />
                  <span className="field-help">Profile information only; it is not used to sign in.</span>
                </label>
              </div>
            </fieldset>

            <fieldset className="form-section">
              <legend><span className="form-step">2</span> Departments</legend>
              <div className="profile-field-block">
                <span className="field-help">
                  Tick up to 12 of the {others} departments you work with;
                  questions search all of them. The first is your{" "}
                  <strong>Main</strong> posting (change it on any ticked row);
                  mark <strong>Addl. charge</strong> where it applies. Tick none
                  to search every department.
                </span>
                <DepartmentChecklist
                  departments={departments}
                  selected={selectedDepartments}
                  onChange={setSelectedDepartments}
                  charged={additionalCharge}
                  onChargedChange={setAdditionalCharge}
                  primary={primaryDepartment}
                  onPrimaryChange={setPrimaryDepartment}
                />
              </div>
            </fieldset>

            <fieldset className="form-section">
              <legend><span className="form-step">3</span> Answers</legend>
              <div className="onboarding-grid">
                <div className="profile-field-block">
                  <div className="profile-field-label">Answer language</div>
                  <div className="segmented" role="radiogroup" aria-label="Answer language">
                    {([["en", "English"], ["hi", "हिन्दी"]] as const).map(([value, label]) => (
                      <label key={value} className={preferredLanguage === value ? "active" : ""}>
                        <input
                          type="radio"
                          name="preferred-language"
                          value={value}
                          checked={preferredLanguage === value}
                          onChange={() => setPreferredLanguage(value)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="profile-field-block">
                  <div className="profile-field-label">Search by default in</div>
                  <div className="segmented" role="radiogroup" aria-label="Default search scope">
                    {([["my_departments", "My departments"], ["all_departments", "All departments"]] as const).map(([value, label]) => (
                      <label key={value} className={defaultScope === value ? "active" : ""}>
                        <input
                          type="radio"
                          name="default-scope"
                          value={value}
                          checked={defaultScope === value}
                          onChange={() => setDefaultScope(value)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </fieldset>

            {error ? <div className="error-box">{error}</div> : null}

            <div className="form-actions">
              {profiles.length ? (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => {
                    setError(null);
                    setCreating(false);
                  }}
                >
                  Cancel
                </button>
              ) : null}
              <button
                className="onboarding-submit"
                type="submit"
                disabled={busy || !displayName.trim()}
              >
                {busy ? "Working…" : "Create profile and continue"}
              </button>
            </div>
          </form>
        )}

        <p className="onboarding-footnote">
          Development profiles: sign-in uses an HttpOnly session cookie; profiles,
          departments and chat history are stored in PostgreSQL.
        </p>
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
  const [departmentLabels, setDepartmentLabels] = useState<DepartmentLabels>({});
  const [places, setPlaces] = useState<PlaceState[]>([]);
  const [maxProfiles, setMaxProfiles] = useState(5);
  const [departmentNameLanguage, setDepartmentNameLanguageState] =
    useState<DepartmentNameLanguage>("en");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DEPARTMENT_NAMES_STORAGE_KEY);
      if (stored === "hi" || stored === "en") setDepartmentNameLanguageState(stored);
    } catch {
      // English first when browser storage is unavailable.
    }
  }, []);
  const departmentNameChoice = {
    language: departmentNameLanguage,
    setLanguage: (next: DepartmentNameLanguage) => {
      setDepartmentNameLanguageState(next);
      try {
        window.localStorage.setItem(DEPARTMENT_NAMES_STORAGE_KEY, next);
      } catch {
        // The choice still applies on this page.
      }
    },
  };

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
            maxProfiles?: number;
          }>(
            "/api/session/dev-users",
          );

        setDevProfiles(
          data.profiles,
        );
        if (data.maxProfiles) setMaxProfiles(data.maxProfiles);
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
                labels?: DepartmentLabels;
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
            setDepartmentLabels(departmentData.labels ?? {});
            // LGD states and districts; the profile form falls back to a plain
            // state list if this is unavailable.
            void jsonRequest<{ states: PlaceState[] }>("/api/workspace/places")
              .then((data) => {
                if (!cancelled) setPlaces(data.states);
              })
              .catch(() => undefined);

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

  // Switching shows the profile list over the current workspace. Nothing is
  // signed out or cleared until another profile is chosen, so "Back" returns
  // to exactly where the person was.
  const [switchingProfile, setSwitchingProfile] = useState(false);

  const switchProfile =
    async () => {
      setError(null);
      setProfileEditing(false);
      setSwitchingProfile(true);
      await loadDevProfiles();
    };

  const finishSwitch = async (next: WorkspaceProfile) => {
    setSwitchingProfile(false);
    setArchivedConversations([]);
    setHistoryView("recent");
    const url = new URL(window.location.href);
    url.searchParams.delete("conversation");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setMode("ask");
    await activateProfile(next);
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
          title={
            archived && conversation.archivedReason === "inactive"
              ? `${conversation.title} — archived automatically after 30 days without activity`
              : undefined
          }
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

  const renderArchiveHistory = (items: ConversationSummary[]) =>
    archiveMonthGroups(items).map((month) => {
      const collapseKey = `archived-month:${month.key}`;
      const collapsed = collapsedDateGroups.has(collapseKey);
      const groupId = `history-${collapseKey.replace(":", "-")}`;
      return (
        <section className="history-date-section archive-month" key={collapseKey}>
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
            <span>{month.label}</span>
            <svg className={collapsed ? "collapsed" : ""} viewBox="0 0 20 20" aria-hidden="true">
              <path d="m5 7.5 5 5 5-5" />
            </svg>
            <small className="history-date-count">{month.count}</small>
          </button>
          <div id={groupId} className="history-date-items" role="group" aria-label={`${month.label} archived conversations`} hidden={collapsed}>
            {!collapsed
              ? month.days.map((day) => (
                  <div className="archive-day" key={day.key}>
                    <div className="archive-day-label">{day.label}</div>
                    {renderConversationRows(day.conversations, true)}
                  </div>
                ))
              : null}
          </div>
        </section>
      );
    });

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

  if (!profile || switchingProfile) {
    return (
      <DepartmentLabelsContext.Provider value={departmentLabels}>
      <DepartmentNameLanguageContext.Provider value={departmentNameChoice}>
      <PlacesContext.Provider value={places}>
      <Onboarding
        departments={
          departments
        }
        profiles={
          devProfiles
        }
        maxProfiles={maxProfiles}
        onProfilesChanged={({ signedOut }) => {
          if (signedOut) {
            // The profile in use was deleted: no profile until another is picked.
            setProfile(null);
            setSelectedConversationId(null);
            setSwitchingProfile(false);
          }
          void loadDevProfiles();
        }}
        onCancel={profile && switchingProfile ? () => setSwitchingProfile(false) : undefined}
        currentName={profile?.displayName}
        currentId={profile?.id}
        onLogin={(
          active,
        ) => {
          void finishSwitch(
            active,
          );
        }}
        onCreated={(
          created,
        ) => {
          void finishSwitch(
            created,
          );

          void loadDevProfiles();
        }}
      />
      </PlacesContext.Provider>
      </DepartmentNameLanguageContext.Provider>
      </DepartmentLabelsContext.Provider>
    );
  }

  return (
    <DepartmentLabelsContext.Provider value={departmentLabels}>
    <DepartmentNameLanguageContext.Provider value={departmentNameChoice}>
    <PlacesContext.Provider value={places}>
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
          <div className="history-scope-head">
            <div className="section-label">
              Working scope
            </div>
            {profile.departments.length ? <DepartmentNameToggle /> : null}
          </div>

          {profile.departments.length === 0 ? (
            <span className="scope-all">
              No department set · searching all departments
            </span>
          ) : (
            departmentChoiceList(profile.departments, departmentLabels).map((department) => {
              const charge = departmentChoiceList(profile.additionalChargeDepartments ?? [], departmentLabels).includes(department);
              const primary =
                !!profile.primaryDepartment &&
                department === departmentChoice(profile.primaryDepartment, departmentLabels);
              const shown = departmentDisplay(department, departmentLabels, departmentNameLanguage);
              return (
                <span
                  key={department}
                  className={primary ? "scope-department scope-primary" : "scope-department"}
                  title={shown.sub ?? undefined}
                >
                  {shown.main}
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
            <p className="archive-note">
              Chats with no activity for 30 days move here automatically, grouped by the date they were last used.
              Pinned chats stay. Restore a chat to continue it.
            </p>
            <nav className="history-list" aria-label="Archived conversations">
              {visibleArchivedConversations.length > 0
                ? renderArchiveHistory(visibleArchivedConversations)
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
          <SearchApp scopeDepartments={profile.departments} />
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
    </PlacesContext.Provider>
    </DepartmentNameLanguageContext.Provider>
    </DepartmentLabelsContext.Provider>
  );
}
