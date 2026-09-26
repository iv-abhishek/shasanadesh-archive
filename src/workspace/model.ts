export type PreferredLanguage =
  | "en"
  | "hi";

export type DefaultScope =
  | "my_departments"
  | "all_departments";

export interface WorkspaceProfileInput {
  displayName: string;
  designation?: string;
  stateName?: string;
  district?: string;
  contactNumber?: string;
  preferredLanguage:
    PreferredLanguage;
  defaultScope:
    DefaultScope;
  /** Substantive posting. Optional: a profile may have no department. */
  primaryDepartment?:
    string | null;
  additionalDepartments?:
    string[];
  /** Subset of departments held as additional charge. */
  additionalChargeDepartments?:
    string[];
}

const departmentKey = (name: string) =>
  name.trim().toLocaleLowerCase("en");

/**
 * Normalise a profile's department assignments.
 *
 * - The primary department is optional; an officer may have none, one, or
 *   several departments at a time.
 * - Names are trimmed and de-duplicated case-insensitively, primary first.
 * - Additional-charge flags are kept only for assigned, non-primary
 *   departments (the substantive posting is never "additional charge").
 */
export function normalizeDepartmentNames(
  primaryDepartment: string | null | undefined,
  additionalDepartments:
    string[] = [],
  additionalChargeDepartments:
    string[] = [],
): {
  primaryDepartment: string | null;
  departments: string[];
  additionalCharge: string[];
} {
  const primary =
    primaryDepartment?.trim() || null;

  const seen =
    new Set<string>();

  const departments:
    string[] = [];

  for (
    const candidate of [
      ...(primary ? [primary] : []),
      ...additionalDepartments,
    ]
  ) {
    const normalized =
      candidate.trim();

    if (!normalized) {
      continue;
    }

    const key =
      departmentKey(normalized);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    departments.push(
      normalized,
    );
  }

  const chargeKeys = new Set(
    additionalChargeDepartments.map(departmentKey),
  );

  const additionalCharge = departments.filter(
    (department) =>
      department !== primary &&
      chargeKeys.has(departmentKey(department)),
  );

  return {
    primaryDepartment:
      primary,
    departments,
    additionalCharge,
  };
}

export function defaultConversationTitle(
  firstQuestion: string,
): string {
  const normalized =
    firstQuestion
      .replace(/\s+/g, " ")
      .trim();

  if (!normalized) {
    return "New conversation";
  }

  const maxChars = 72;

  return normalized.length <=
    maxChars
    ? normalized
    : `${normalized
        .slice(
          0,
          maxChars - 1,
        )
        .trimEnd()}…`;
}
