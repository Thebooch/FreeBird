import type { Generated, JSONColumnType } from "kysely";
import type { ChatMessage, CustomTab, Reference } from "@freebirdai/core";

/**
 * Kysely schema reflecting `migrations/001_init.sql`. Host apps may extend
 * this schema with their own tables and pass the extended type when calling
 * `new Kysely<FreeBirdSchema & MyExtras>()`.
 */
export interface FreeBirdSchema {
  freebird_chat_session: {
    id: string;
    title: string | null;
    topic: string | null;
    tags: string[];
    user_id: string | null;
    /** Nullable tenant scope for multi-tenant (Studio) deployments. */
    tenant_id: string | null;
    active_layout_id: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  freebird_chat_message: {
    id: string;
    session_id: string;
    role: ChatMessage["role"];
    content: string;
    references_json: JSONColumnType<Reference[]>;
    tool_name: string | null;
    tool_payload: JSONColumnType<Record<string, unknown> | null> | null;
    tenant_id: string | null;
    created_at: Generated<Date>;
  };
  freebird_custom_tab: {
    id: string;
    title: string;
    slug: string | null;
    owner_id: string | null;
    tenant_id: string | null;
    layout: JSONColumnType<CustomTab["layout"]>;
    digest: JSONColumnType<NonNullable<CustomTab["digest"]>> | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  freebird_lock: {
    key: string;
    expires_at: Date;
  };
  /**
   * Host-app scratch. See `migrations/003_scratch.sql` for why `tenant_id`
   * and `user_id` are non-null here when they are nullable everywhere else:
   * the key is chosen by the host and collides across tenants by design, so
   * identity is part of the primary key rather than a filter that can be
   * skipped.
   */
  freebird_scratch: {
    tenant_id: Generated<string>;
    user_id: Generated<string>;
    scope: string;
    namespace: string;
    /**
     * Whatever the host parked. Deliberately not `JSONColumnType`, which
     * constrains the value to an object — scratch is opaque by design, and an
     * array or a bare scalar is a legitimate thing to keep.
     */
    data: unknown;
    expires_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
}
