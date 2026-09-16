import type { ChatMessage, ComponentCitation } from "@freebirdai/core";
import {
  activateCitation,
  citationsFromToolPayload,
  replayPendingCitation,
} from "@freebirdai/core";
import { navigate, parseRoute } from "./route.js";
import { showWidget } from "./showWidget.js";

/**
 * What sits under a reply: where it came from, and how far it looked.
 *
 * Two different promises, so two different affordances, both in the corner
 * where a footnote belongs rather than in the sentence.
 *
 * A **citation** is a place. The assistant appends `[[cite:<id>]]` to anything
 * grounded in a widget; the server strips the marker and resolves it into a
 * chip carrying that widget's tab and its cell selector. Clicking one goes
 * there — switching tabs on the way when it has to — and pulses the tile, so
 * "38 active leases" is one click from the thing that says 38.
 *
 * **Coverage** is a limit. When the answer came from a bounded sample, the
 * bubble says so and offers to go further. The note and the button are the one
 * piece of fixed copy in a reply, deliberately: they are chrome making a
 * standing offer, not the assistant speaking. Everything it *says* about what
 * going further would cost is generated, because that depends on the data.
 */

/** What a widget citation resolves to, before the click is acted on. */
export const citationsOf = (message: ChatMessage): ComponentCitation[] =>
  citationsFromToolPayload(message.toolPayload);

/**
 * The harness's own account of what it read, carried through the engine's
 * generic tool-payload passthrough.
 */
export interface CoverageNote {
  readonly scanned: number;
  readonly of: number | null;
  readonly orderedBy: string | null;
  readonly sources: readonly string[];
}

/** Records an answer came from that the board does not show. */
export interface WidgetOffer {
  readonly title: string;
  readonly connection: string;
}

/**
 * Reading the harness's own account of what it read.
 *
 * One payload carries both the coverage note and the offer, because a tool
 * contributes one — so each reader takes the half it is about and ignores the
 * other. A complete answer carries no coverage and may still carry an offer.
 */
const readPayload = (message: ChatMessage): (CoverageNote & { offer?: WidgetOffer }) | null => {
  const payload = message.toolPayload as
    | { toolPayloads?: Array<{ tool: string; payload: unknown }> }
    | null
    | undefined;
  for (const entry of payload?.toolPayloads ?? []) {
    const value = entry.payload as
      | (CoverageNote & { kind?: string; offer?: WidgetOffer })
      | null;
    if (value && typeof value === "object" && value.kind === "coverage") {
      return {
        scanned: value.scanned,
        of: value.of ?? null,
        orderedBy: value.orderedBy ?? null,
        sources: value.sources ?? [],
        ...(value.offer ? { offer: value.offer } : {}),
      };
    }
  }
  return null;
};

export const offerOf = (message: ChatMessage): WidgetOffer | null =>
  message.role === "assistant" ? (readPayload(message)?.offer ?? null) : null;

export const coverageOf = (message: ChatMessage): CoverageNote | null => {
  const payload = message.toolPayload as
    | { toolPayloads?: Array<{ tool: string; payload: unknown }> }
    | null
    | undefined;
  for (const entry of payload?.toolPayloads ?? []) {
    const value = entry.payload as (CoverageNote & { kind?: string }) | null;
    if (value && typeof value === "object" && value.kind === "coverage") {
      /*
       * A payload carrying only an offer says nothing about coverage, and a
       * note reading "based on the first 0 records" would be worse than
       * silence.
       */
      if (!(value.scanned > 0)) return null;
      return {
        scanned: value.scanned,
        of: value.of ?? null,
        orderedBy: value.orderedBy ?? null,
        sources: value.sources ?? [],
      };
    }
  }
  return null;
};

/**
 * How the note reads.
 *
 * "the 50 most recent" is only honest when something actually sorted them.
 * With no sort the phrase names the order the source happened to return, which
 * is what the user will find if they go and look.
 */
export const coverageLabel = (note: CoverageNote): string =>
  note.orderedBy
    ? `this is based on the ${note.scanned} most recent records`
    : `this is based on the first ${note.scanned} records`;

/**
 * Clicking a citation.
 *
 * `activateCitation` handles the same-tab case itself: it compares the
 * citation's hash route against the address bar and scrolls straight to the
 * tile when they match. When they do not it stashes the citation and calls
 * `onNavigate`, and the replay finishes the scroll once the board has
 * re-rendered — which is why the wait is a poll rather than a fixed delay.
 */
export const widgetIdOf = (citation: ComponentCitation): string | null => {
  const match = /^\[data-widget-id="(.*)"\]$/.exec(citation.selector ?? "");
  return match?.[1] ?? null;
};

const goToCitation = async (citation: ComponentCitation): Promise<void> => {
  /*
   * `directive: "scroll-to"` is the contract's own way of saying "move there,
   * I will do the highlight". `focusTarget` otherwise pulses a hardcoded blue,
   * which is a chart colour on a green board — so the cross-tab handling stays
   * shared and only the ring is ours.
   */
  const outcome = await activateCitation(
    { ...citation, directive: "scroll-to" },
    {
      onNavigate: (page) => {
        navigate(parseRoute(page));
        return true;
      },
    },
  );
  /*
   * Nothing reloads here, so the replay has to be driven rather than waited
   * for — and after a tab change the tile does not exist yet at all, which is
   * why this goes through the shared wait-then-ring rather than a query.
   */
  if (outcome.detail === "navigating") await replayPendingCitation();
  const widgetId = widgetIdOf(citation);
  if (widgetId) showWidget(widgetId, { ring: "cited" });
};

export const Citations = ({ message }: { readonly message: ChatMessage }): JSX.Element | null => {
  if (message.role !== "assistant") return null;
  const citations = citationsOf(message);
  if (citations.length === 0) return null;
  return (
    <div className="dash-chat__cites" data-testid="chat-citations">
      {citations.map((citation) => (
        <button
          key={citation.componentId}
          type="button"
          className="dash-chat__cite"
          data-component={citation.componentId}
          title={`Show "${citation.title}"`}
          onClick={() => void goToCitation(citation)}
        >
          {citation.title}
        </button>
      ))}
    </div>
  );
};

/**
 * An offer to build the thing the answer came from.
 *
 * Deliberately chrome rather than something the assistant says. An offer that
 * depends on a model remembering to make it appears three times out of five,
 * and the one time it matters is the time it does not. Clicking sends an
 * ordinary message, so what happens next is the same conversation that builds
 * every other widget — it asks what to include rather than guessing.
 */
export const OfferWidget = ({
  message,
  onAsk,
}: {
  readonly message: ChatMessage;
  readonly onAsk: (question: string) => void;
}): JSX.Element | null => {
  const offer = offerOf(message);
  if (!offer) return null;
  return (
    <div className="dash-chat__coverage" data-testid="chat-offer">
      <button
        type="button"
        className="dash-chat__deeper"
        data-testid="chat-add-widget"
        onClick={() => onAsk(`Add a widget for ${offer.title}.`)}
      >
        add this as a widget?
      </button>
    </div>
  );
};

export const DigDeeper = ({
  message,
  onAsk,
}: {
  readonly message: ChatMessage;
  readonly onAsk: (question: string) => void;
}): JSX.Element | null => {
  if (message.role !== "assistant") return null;
  const note = coverageOf(message);
  if (!note) return null;
  return (
    <div className="dash-chat__coverage" data-testid="chat-coverage">
      <span className="dash-chat__coverage-note">{coverageLabel(note)}</span>
      <button
        type="button"
        className="dash-chat__deeper"
        data-testid="chat-dig-deeper"
        /*
         * Sent as an ordinary message rather than through a special route.
         * The harness already takes a scope, so going deeper is the same
         * search with a wider one — and routing it through the conversation
         * means the reply about what that would cost is generated like every
         * other reply, rather than being a number pasted into fixed copy.
         *
         * It asks for the options first on purpose. A deep read spends real
         * requests and a round of model calls per hundred records; offering
         * the choice is what makes that the user's decision rather than a
         * consequence of clicking something small in a corner.
         */
        onClick={() =>
          onAsk(
            "Go deeper on that — read past the sample and answer the same question. " +
              "First give me the options: how many records, how far back, or all of them, " +
              "and what each would cost.",
          )
        }
      >
        dig deeper?
      </button>
    </div>
  );
};
