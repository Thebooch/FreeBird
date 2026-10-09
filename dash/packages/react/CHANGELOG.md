# @freebirdai/dash-react

## 0.2.0

### Minor Changes

- 3d5061b: The Calendar section: events, deadlines and appointments from agents, workflows and people, each in its owner's colour.
  - Dash spec: the calendar entry moves to `calendar.ts` and grows a `kind` (`event`, `deadline`, `appointment`), a `status` (`open`, `tentative`, `done`, `cancelled`), `notes`, the record it is about (`source`), a `dedupeKey` so a workflow moves its entry instead of making another, and `pinned` for an entry a person changed by hand. Entries stored with `deadline: true` still read, as `kind: "deadline"`. Helpers `calendarOverlaps`, `calendarStart`, `calendarEnd`, `calendarSortKey`, `ownerKey`, and `calendarEntryInputSchema` for entries added by hand. A new `calendar.manage` permission (owner, admin, editor).
  - Dash react: the calendar page's styles (`styles-calendar.ts`), part of `DASH_REACT_STYLES`: month, week and agenda views, the legend, entry sheets and the entry form, plus a segmented control and a switch.
  - Dash spec: scheduling (`scheduling.ts`). Profiles say whose time can be booked: hours, time zone, whether hours outside blocks are open, and their own defaults. Pools share bookings between people by turns, least busy or priority. Appointment types say what can be booked and on what terms. Blocks (`set`, `blank`, `closed`) say who may book in a time range, from field rules on the contact and the booking, and placements put a block on a person's or a pool's calendar once or repeating daily, weekly or monthly. Settings resolve in layers (`resolveSettings`: workspace → person → type → block), with one buffer set for everyone or per block, and consolidation as stacked or back to back.
  - Dash react: the scheduling setup styles (`styles-scheduling.ts`), part of `DASH_REACT_STYLES`: appointment types, blocks and placements, people and pools, settings, the rule builder, working hours, and block bands behind the week view.
  - Dash spec: contacts (`contact.ts`). A contact is found by a normalized email (`normalizeEmail`) or E.164 phone (`normalizePhone`), never a name. Its fields keep each value with where it came from (a matched record, the person, or a member), and `fieldValueOf` picks the strongest: member, then record, then the person. Field definitions say a field's kind, whether it may be asked, whether rules trust only records, and which record fields fill it (with values mapped to yours); match rules say which of the contact's keys equals which field of a record. A new `contacts.manage` permission (owner, admin, editor).
  - Dash react: the Contacts section's styles (`styles-contacts.ts`), part of `DASH_REACT_STYLES`: the searchable list, the contact sheet with where each value came from, linked records and activity, and the field and matching setup.
  - Dash spec: bookings (`booking.ts`, `booking-events.ts`). A booking holds time while pending, suggested or confirmed (`holdsOf`), falls due by itself when a hold or offer runs out or the appointment ends (`dueAt`), and every change is a `BookingEvent`. Workflows gain a `booking` trigger (which events, which appointment types, whether cancelling stops the case), a `schedule` base (find, hold, confirm, offer other times, cancel, move, assign, mark), `ask.booking` (Approve a booking), `wait.booking`, `wait.appointment` and `outreach.inform` (Tell them what was decided), a `booking` task body, two drafting suggestions, and `builtIn` on templates.
  - Dash react: the booking sheet, the booking trigger's editor and template blanks in the shipped styles.
  - Dash spec: Approve a booking takes `maxSuggestions` and `remindAfter` (one reminder, then it waits on), and its task body carries `maxSuggestions` and `remindedAt`.
  - Dash react: styles for copying a link a member hands out and for a contact's booking links.
  - Dash spec: an agent's `schedule_appointment` tool says which appointment types it may book and how it offers each (`schedule: { types, offer }`), and the reply prompt gains a "Booking appointments" section while one is on: offer one time at a time, never a time no tool returned, and say plainly whether a time is booked or only requested (`SchedulingPromptInput`). "Make a scheduling link" is available as a workflow step.
  - Dash react: the booking tool's settings in the agent editor.
  - Dash react: the calendar's Subscribe panel, for a member's own read-only calendar feed.
  - Dash spec: an appointment type can say who can book it (`eligibility`: rules over the person's contact fields and the answers to the type's own questions, such as party size, what to do while an answer isn't known, and what to tell someone it doesn't take).
  - Dash spec: a booking trigger can start on someone being turned away (`turned_away`), once a day per person and type, with the person, the type and their answers to work with.

- 76dc96c: Connection onboarding: a new connection ends by asking what somebody wants from it and building it.
  The API behind it is prepared once for everybody who connects it — what the software is, the parts it
  divides into, a starter set of widget briefs per part, and how often each kind of record arrives — one
  step per request, each written as it lands, so preparation resumes wherever it stopped. The person then
  chooses parts and one tab or a tab each, previews the boards with every widget tried against their account
  (a refused widget is left off with its reason; one that could not be tried because of a rate limit is
  kept), and creates exactly what was previewed. Setup is a resumable state on the connection
  (`pending → choosing → preview → creating → complete`, or `skipped`); an interrupted create finishes the
  same boards without overwriting any it already wrote. Existing connections reach it from their
  **Dashboards** button, which also makes another set.

  The shared half stores briefs, never widgets, and a fingerprint of the API reading it was made against,
  so a re-described API is prepared again rather than served stale. Starter composition refuses widgets
  whose endpoints need inputs a board cannot supply, and both model passes retry once with the reasons they
  were refused.

  Keeping boards fresh: a board being looked at reads the server's cache and never calls the API; the
  keeper refreshes, on each endpoint's cadence, exactly the requests boards made — including changed filters,
  picked ranges and path parameters — and warms new boards before they are opened. It reads refusals behind
  cached copies (a 401 or 403 stops a target until the connection's key changes; a 429 pauses the connection
  until the API allows it), and a changed cadence applies at the next tick. Polls re-read the server rather
  than the API, and staleness is labelled against the endpoint's cadence. The cache key no longer carries the
  time range for endpoints that do not read it, and 304 responses are no longer treated as redirects.

  Catalog, connection, dashboard and cadence files are written atomically.

- 24ecda1: Preserve endpoint contracts and connection-scoped field evidence throughout guided setup. Retain widget coercions, formatting, nested fields and measurements in every draft part; share the REST patch schema with the agent and browser.

  Initialize declared pagination on the first request, keep imported pagination hints inactive, preserve multipart authentication requirements, isolate catalog credentials, and invalidate stale reports and queries after execution changes. Failed mapping passes remain retryable.

  Check guided widget previews against cached upstream responses before either confirmation path saves them. Distinguish unchecked, invalid, empty and partial previews. Legacy catalog connections with ambiguous shared multipart credentials require re-entry; saved widget calculations are not rewritten.

  Preserve source-specific conversions in combined comparisons, including nested money values, and keep account identities on primary and secondary ambiguity choices. Persist mapping and labeling batch checkpoints so retries resume only unfinished work. Honor endpoint-level OpenAPI authentication overrides and expose their credential slots in the connection UI.

### Patch Changes

- 474e53c: Move the integration engine into `@freebirdai/connect`: discovery, sign-in, mapping, the response cache and keeper, jobs, drift, evidence and reviewed writes, the REST and MCP source adapters (formerly `@freebirdai/dash-adapters`), and the API-mapping half of the authoring agent. `@freebirdai/dash-agent` re-exports the moved agent passes. A saved connection's `onboarding` and a category's `starters` are now stored by the engine without being read; Dash reads them through `onboardingOf` and `startersOf`.
- Updated dependencies [01e073a]
- Updated dependencies [6b7bfe5]
- Updated dependencies [7bb37b8]
- Updated dependencies [b1b8de4]
- Updated dependencies [4488a52]
- Updated dependencies [ce27094]
- Updated dependencies [474e53c]
- Updated dependencies [b403d7b]
- Updated dependencies [cacc921]
- Updated dependencies [c042b29]
- Updated dependencies [be9f5ec]
- Updated dependencies [4175415]
- Updated dependencies [3d5061b]
- Updated dependencies [76dc96c]
- Updated dependencies [24ecda1]
- Updated dependencies [fd7fcf7]
  - @freebirdai/connect@0.2.0
  - @freebirdai/dash-spec@0.2.0
  - @freebirdai/dash-components@0.2.0
  - @freebirdai/dash-runtime@0.2.0
