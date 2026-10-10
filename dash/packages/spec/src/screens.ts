/**
 * The screens the chat can act on, by the id they are registered under as
 * guide components and the address they live at. One list for the server
 * (which registers them, `chat/screens/`) and the web app (which marks them
 * `data-freebird-component` and tells the chat which are on screen), so the
 * two never drift.
 */
export const DASH_SCREENS = {
  calendar: { id: "calendar", page: "#/agent/calendar" },
  bookings: { id: "calendar-bookings", page: "#/agent/calendar" },
  types: { id: "calendar-types", page: "#/agent/calendar/types" },
  blocks: { id: "calendar-blocks", page: "#/agent/calendar/blocks" },
  people: { id: "calendar-people", page: "#/agent/calendar/people" },
  settings: { id: "calendar-settings", page: "#/agent/calendar/settings" },
  contacts: { id: "contacts", page: "#/agent/contacts" },
  contactFields: { id: "contact-fields", page: "#/agent/contacts/fields" },
} as const;

export type DashScreen = keyof typeof DASH_SCREENS;
