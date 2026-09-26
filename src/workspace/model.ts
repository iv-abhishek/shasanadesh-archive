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
  primaryDepartment:
    string;
  additionalDepartments?:
    string[];
}

export function normalizeDepartmentNames(
  primaryDepartment: string,
  additionalDepartments:
    string[] = [],
): {
  primaryDepartment: string;
  departments: string[];
} {
  const primary =
    primaryDepartment
      .trim();

  if (!primary) {
    throw new Error(
      "Primary department is required.",
    );
  }

  const seen =
    new Set<string>();

  const departments:
    string[] = [];

  for (
    const candidate of [
      primary,
      ...additionalDepartments,
    ]
  ) {
    const normalized =
      candidate.trim();

    if (!normalized) {
      continue;
    }

    const key =
      normalized.toLocaleLowerCase(
        "en",
      );

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    departments.push(
      normalized,
    );
  }

  return {
    primaryDepartment:
      primary,
    departments,
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
