/**
 * What a grant is a grant *to*.
 *
 * A declaration is a set of capability strings — `"connection:stripe"`,
 * `"op:charges.list"`, `"action:invoice/send"`. Deliberately opaque strings
 * rather than a typed union: Guide and Dash declare different kinds of reach,
 * and the comparison this file exists for is set membership, which does not
 * care what the strings mean.
 *
 * Sets, not lists. Two declarations naming the same capabilities in a
 * different order are the same declaration, and normalizing on the way in is
 * what lets every later comparison be a plain lookup.
 */

export type Capability = string;

export type Declaration = readonly Capability[];

/** Sorted and deduplicated, so equal declarations are literally equal. */
export const normalizeDeclaration = (capabilities: Iterable<Capability>): Capability[] =>
  [...new Set(capabilities)].sort();

/** Capability naming helpers, so the two products spell these the same way. */
export const connectionCapability = (connectionId: string): Capability =>
  `connection:${connectionId}`;

export const opCapability = (connectionId: string, opId: string): Capability =>
  `op:${connectionId}/${opId}`;

export const actionCapability = (componentId: string, actionId: string): Capability =>
  `action:${componentId}/${actionId}`;
