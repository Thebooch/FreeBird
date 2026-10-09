---
"@freebirdai/dash-web": patch
---

Record type pickers in the workflow editor, step panel, agent access and agent tools show each record type's plural name instead of passing the catalog's `{ one, many }` name to React, which threw "Objects are not valid as a React child" on any connection with catalogued record types. `api.connectionEntities` is now typed with the shape the server sends (`ConnectionEntity`), and one shared `recordTypeChoices` mapping turns it into picker rows.
