---
"@freebirdai/dash-spec": minor
"@freebirdai/dash-react": minor
---

The Calendar section: events, deadlines and appointments from agents, workflows and people, each in its owner's colour.

- Dash spec: the calendar entry moves to `calendar.ts` and grows a `kind` (`event`, `deadline`, `appointment`), a `status` (`open`, `tentative`, `done`, `cancelled`), `notes`, the record it is about (`source`), a `dedupeKey` so a workflow moves its entry instead of making another, and `pinned` for an entry a person changed by hand. Entries stored with `deadline: true` still read, as `kind: "deadline"`. Helpers `calendarOverlaps`, `calendarStart`, `calendarEnd`, `calendarSortKey`, `ownerKey`, and `calendarEntryInputSchema` for entries added by hand. A new `calendar.manage` permission (owner, admin, editor).
- Dash react: the calendar page's styles (`styles-calendar.ts`), part of `DASH_REACT_STYLES`: month, week and agenda views, the legend, entry sheets and the entry form, plus a segmented control and a switch.
