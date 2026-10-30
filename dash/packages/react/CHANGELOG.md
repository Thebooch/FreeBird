# @freebirdai/dash-react

## 0.2.0

### Minor Changes

- 35ba3ac: Everything on the calendar and contacts screens can be asked for in the chat, and is done only on Approve.
  - Dash spec: `DASH_SCREENS`, the id and page of each calendar and contacts screen the chat can change (calendar, bookings, appointment types, blocks, people and pools, scheduling settings, contacts, contact fields), shared by server and web.
  - Dash react: `styles-chat-cards.ts`, part of `DASH_REACT_STYLES`: the approval card (what the change does, each setting before and after, Approve and Cancel), the card for a link shown once, and the ring on a setting a citation chip opens.

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

- 3826ac3: The chat works every page the same way: workflows, agents and dashboards join the calendar and contacts.
  - Dash spec: `DASH_SCREENS.workflows`, `.agents` and `.board` (the open dashboard tab).
  - Dash react: `Dashboard` takes `rootData`, `data-*` attributes for its root, so a host can name the board for an assistant's citations without wrapping it.

- ee1d19b: Email in Communications: Gmail and Outlook mailboxes, merged, with agents' replies sent only through the review.
  - Connect spec: a connection can be a mailbox (`mailbox`: provider, address, and its owner, the team or one agent). OAuth sign-in takes `authorizeParams`, the provider's own fixed values (Google's `access_type=offline`). A write endpoint can declare its `role` (for one whose path does not say it, like Gmail's `POST /messages/send`), and a write body can be an email (`mime`): its `to`, `cc`, `subject`, `text` and threading headers are reviewed as fields and sent as one encoded message.
  - Connect: the write service encodes such a body after the review is built, so the digest covers what is sent; the REST write sends a body that is already text as it is.
  - Dash spec: Communications (`comms.ts`): one message shape for both providers, drafts, what agents did with each message, the areas (Your comms, and one per agent), and one small search syntax (`from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `before:`, `after:`) with `matchesMailQuery` for filtering what is shown. A `message_received` workflow trigger and a **Reply to the email** step (`outreach.reply`). Contacts can come from an email (`origin: "email"`).
  - Dash react: Communications' styles (`styles-comms.ts`), part of `DASH_REACT_STYLES`.

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

- 3cc3f53: Timed reports: a tab, or some of its widgets, emailed on a schedule with a short written summary.
  - Dash spec: reports (`report.ts`). A report is a stack of blocks (a whole tab, one widget, a tracked value over a window, a note), a schedule (cron in its own time zone), recipients, who unsubscribed, an optional agent, and whether a summary is written. A tracked value is one number kept daily from a connection's records, narrowed by a filter to one record or group. Helpers `cronForCadence`, `cadenceOfCron` and `describeSchedule` turn daily, weekday, weekly and monthly schedules into cron and back; `reportDashboards` names the tabs a report draws from. Each send is a `ReportSend`.
  - Dash spec: a **Send a report** workflow step (`send.report`) and a `report` setting kind.
  - Dash react: the Reports pop-up's styles (`styles-reports.ts`), part of `DASH_REACT_STYLES`: the list of a tab's reports and the editor with its email preview.
  - Dash spec: a tab, widget or tracked-value block takes `emphasis`, what its reader most wants to know, which its summary answers first.
  - Dash spec: a board takes `bar`, the tab bar it sits on (absent: the first).
  - Dash react: styles for several tab bars: the arrows between bars, the fixed New tab behind its rule, and arrows that scroll a bar of tabs too wide to show.

### Patch Changes

- 474e53c: Move the integration engine into `@freebirdai/connect`: discovery, sign-in, mapping, the response cache and keeper, jobs, drift, evidence and reviewed writes, the REST and MCP source adapters (formerly `@freebirdai/dash-adapters`), and the API-mapping half of the authoring agent. `@freebirdai/dash-agent` re-exports the moved agent passes. A saved connection's `onboarding` and a category's `starters` are now stored by the engine without being read; Dash reads them through `onboardingOf` and `startersOf`.
- 098e39e: Communications, the last of plan 7.
  - Dash spec: a contact keeps the ids of contacts merged into it (`aliases`), and `contactKeys` claims them, so an old id still finds the contact. A `contact_created` workflow trigger (and a `contact` start). Agents take a **Search mail** tool (`search_mail`). `TimelineTask` has an `email` kind.
  - Dash react: styles for the contact card beside a conversation, a contact's messages, marks on mail, and the condition pickers.

- f1fa41c: Communications, the rest of plan 7: agents start email conversations, the team hears by email, contacts fill and type themselves, and calendars sync.
  - Connect spec: a mailbox can carry `calendar` (whose it is, keep its busy times free, put appointments in it).
  - Dash spec: `CommsSettings.noticesTo`, where team notices go for anyone without an email of their own. `MailboxView` says how its calendar is used and how writing to it last went.
  - Dash spec: a contact field can fill from email (`fromEmail`, with what to look for); a match rule can name a contact type (`type`), and `contactTypes` gives a contact's types from the rules it is linked by. Contacts can come from email (`origin: "email"`).
  - Dash react: styles for Comms' settings link.

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
- Updated dependencies [3f1f55e]
- Updated dependencies [be9f5ec]
- Updated dependencies [4175415]
- Updated dependencies [35ba3ac]
- Updated dependencies [3d5061b]
- Updated dependencies [3826ac3]
- Updated dependencies [ee1d19b]
- Updated dependencies [098e39e]
- Updated dependencies [f1fa41c]
- Updated dependencies [76dc96c]
- Updated dependencies [24ecda1]
- Updated dependencies [fd7fcf7]
- Updated dependencies [3cc3f53]
  - @freebirdai/connect@0.2.0
  - @freebirdai/dash-spec@0.2.0
  - @freebirdai/dash-components@0.2.0
  - @freebirdai/dash-runtime@0.2.0
