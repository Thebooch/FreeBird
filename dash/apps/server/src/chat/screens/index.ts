import type { ComponentDefinition } from "@freebirdai/core";
import type { AgentInput, AgentSpec, ContactFieldDef, ContactMatchRule, Principal } from "@freebirdai/dash-spec";
import type { BookingLinks } from "../../bookings/links.js";
import type { BookingService } from "../../bookings/service.js";
import type { CalendarService } from "../../calendar/service.js";
import type { ContactService } from "../../contacts/service.js";
import type { SchedulingOverview, SchedulingService } from "../../scheduling/service.js";
import type { TaskStore } from "../../workflows/store.js";
import { blocksScreen } from "./blocks.js";
import { bookingsScreen } from "./bookings.js";
import { calendarScreen } from "./calendar.js";
import type { ScreenAccess } from "./common.js";
import { contactFieldsScreen } from "./contact-fields.js";
import { contactsScreen } from "./contacts.js";
import { peopleScreen } from "./people.js";
import { settingsScreen } from "./settings.js";
import { typesScreen } from "./types.js";

export { SCREENS, type Screen } from "./common.js";

/** What the calendar's and contacts' screens are built from, each turn. */
export interface ScreensInput extends ScreenAccess {
  readonly calendar: CalendarService;
  readonly scheduling: SchedulingService;
  readonly bookings: BookingService;
  readonly contacts: ContactService;
  readonly links: BookingLinks;
  readonly tasks: TaskStore;
  readonly agents: {
    readonly roster: readonly AgentSpec[];
    update(principal: Principal, id: string, input: AgentInput): Promise<AgentSpec>;
  };
  /** The setup as it was when the turn began: for knowledge and the cards' "before". */
  readonly setup: SchedulingOverview;
  readonly contactSetup: { readonly fields: readonly ContactFieldDef[]; readonly matchRules: readonly ContactMatchRule[] };
}

/**
 * Every calendar and contacts screen as a guide component, in the order a
 * person meets them. Anything the screens can do, the chat can propose; the
 * person approves it on a card.
 */
export const buildScreens = (input: ScreensInput): ComponentDefinition[] => {
  const access: ScreenAccess = { may: input.may, now: input.now, changed: input.changed };
  return [
    calendarScreen({ ...access, calendar: input.calendar, links: input.links, agents: input.agents.roster }),
    bookingsScreen({ ...access, setup: input.setup, bookings: input.bookings, contacts: input.contacts, links: input.links, tasks: input.tasks }),
    typesScreen({ ...access, setup: input.setup, scheduling: input.scheduling, agents: input.agents }),
    blocksScreen({ ...access, setup: input.setup, scheduling: input.scheduling }),
    peopleScreen({ ...access, setup: input.setup, scheduling: input.scheduling }),
    settingsScreen({ ...access, setup: input.setup, scheduling: input.scheduling }),
    contactsScreen({ ...access, contacts: input.contacts, links: input.links, setup: input.setup, fieldKeys: input.contactSetup.fields.map((one) => one.key) }),
    contactFieldsScreen({ ...access, contacts: input.contacts, setup: input.contactSetup }),
  ];
};
