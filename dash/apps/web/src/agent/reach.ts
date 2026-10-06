import { AGENT_PERMISSIONS, type AgentReach, type Permission, type Scope } from "@freebirdai/dash-spec";

/**
 * An agent's reach as the editor shows it: one row for each place, and a
 * checkbox for each thing it may do there. The stored form is a flat list of
 * permission-and-scope pairs (`access.ts`'s own words); this is the same list
 * regrouped, so the editor and the policy never disagree about what is granted.
 */
export interface ReachRow {
  readonly scope: Scope;
  readonly permissions: readonly Permission[];
}

export const rowKey = (scope: Scope): string => `${scope.connection ?? ""}/${scope.entity ?? ""}`;

/** What can be ticked, in the order they are shown. */
export const REACH_CHOICES: ReadonlyArray<{ readonly permission: Permission; readonly label: string }> = [
  { permission: "records.read", label: "Read" },
  { permission: "records.create", label: "Create" },
  { permission: "records.update", label: "Update" },
  { permission: "records.delete", label: "Delete" },
  { permission: "records.act", label: "Act" },
];

export const rowsFromReach = (reach: readonly AgentReach[]): ReachRow[] => {
  const rows = new Map<string, { scope: Scope; permissions: Permission[] }>();
  for (const one of reach) {
    const key = rowKey(one.scope);
    const row = rows.get(key) ?? { scope: one.scope, permissions: [] };
    if (!row.permissions.includes(one.permission)) row.permissions.push(one.permission);
    rows.set(key, row);
  }
  return [...rows.values()].map((row) => ({
    scope: row.scope,
    permissions: AGENT_PERMISSIONS.filter((permission) => row.permissions.includes(permission)),
  }));
};

export const reachFromRows = (rows: readonly ReachRow[]): AgentReach[] =>
  rows.flatMap((row) => row.permissions.map((permission) => ({ permission, scope: row.scope })));

/** A place with nothing ticked is kept while it is being edited, and dropped on save. */
export const addRow = (rows: readonly ReachRow[], scope: Scope): ReachRow[] =>
  rows.some((row) => rowKey(row.scope) === rowKey(scope))
    ? [...rows]
    : [...rows, { scope, permissions: ["records.read"] }];

export const removeRow = (rows: readonly ReachRow[], scope: Scope): ReachRow[] =>
  rows.filter((row) => rowKey(row.scope) !== rowKey(scope));

export const togglePermission = (rows: readonly ReachRow[], scope: Scope, permission: Permission): ReachRow[] =>
  rows.map((row) => {
    if (rowKey(row.scope) !== rowKey(scope)) return row;
    const has = row.permissions.includes(permission);
    const next = has ? row.permissions.filter((one) => one !== permission) : [...row.permissions, permission];
    return { scope: row.scope, permissions: AGENT_PERMISSIONS.filter((one) => next.includes(one)) };
  });
