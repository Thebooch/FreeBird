import type { ConnectionEntity } from "../api";

/**
 * The record types a picker offers, per connection: the id it stores and the
 * words it shows.
 *
 * Shared by every record type picker (an agent's access and tools, a
 * workflow's trigger, source and steps) so they all read the same.
 */
export type Entities = Record<string, Array<{ entity: string; name: string }>>;

/**
 * A connection's record types as a picker shows them.
 *
 * The server sends the catalog's name in both numbers. A picker lists kinds
 * of record, and reads "Suppliers on Acme", so it takes the plural.
 */
export const recordTypeChoices = (list: readonly ConnectionEntity[]): Entities[string] =>
  list.map((one) => ({ entity: one.entity, name: one.name.many }));
