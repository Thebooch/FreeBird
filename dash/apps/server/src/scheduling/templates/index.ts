import { APPROVAL_REMINDER } from "./approval-reminder.js";
import { APPROVAL_REQUEST } from "./approval-request.js";
import { BOOKING_CHANGED } from "./booking-changed.js";
import { CUSTOMER_MESSAGE } from "./customer-message.js";
import { DECISION_RECORDED } from "./decision-recorded.js";

export { APPROVAL_REMINDER, APPROVAL_REQUEST, BOOKING_CHANGED, CUSTOMER_MESSAGE, DECISION_RECORDED };
export { ownLink, render, TemplateVariableError, variablesOf, type MessageTemplate } from "./render.js";

/** Every message template, for the test that holds each one's variables to what it uses. */
export const MESSAGE_TEMPLATES = [APPROVAL_REQUEST, APPROVAL_REMINDER, DECISION_RECORDED, BOOKING_CHANGED, CUSTOMER_MESSAGE] as const;
