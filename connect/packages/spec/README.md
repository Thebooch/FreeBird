# @freebirdai/connect-spec

The schemas FreeBird's integration engine agrees on: connections, connectors,
catalog entries, record types and their relations, evidence, rhythm and
writes. Everything here describes an API and how to read and change it, with
nothing about dashboards.

`@freebirdai/dash-spec` re-exports this package whole and adds the widget,
board and onboarding vocabulary on top, so Dash code keeps importing from
`dash-spec`.

Two fields belong to the host rather than the engine, and are stored without
being read:

- a category's `starters` (Dash types them as widget briefs), and
- a connection's `onboarding` (Dash types it as its setup record).

`categorySchemaOf(starter)` and `categoriesSchemaOf(starter)` build the
category schemas with a host's own starter type; Dash extends
`catalogEntrySchema` and `connectionSchema` with them.

This is the first step of moving the integration engine into its own
`@freebirdai/connect` package; see the plan in the project's
`plans/integration-engine-package.md`.
