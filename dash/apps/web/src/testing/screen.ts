import { act, type ReactElement } from "react";
import { type Root, createRoot } from "react-dom/client";

/**
 * A screen, drawn for a test: mounted in the test's DOM, with the server it
 * talks to answered by the test. Enough to open a screen, press what a person
 * would press, and see what was sent and what is then shown. Used by the
 * `*.test.tsx` files beside the screens; each of those opts in to a DOM with
 * `// @vitest-environment happy-dom` on its first line.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Call {
  readonly method: string;
  /** Path and query, as asked. */
  readonly url: string;
  /** The JSON body sent, parsed; undefined when there was none. */
  readonly body: unknown;
}

/** What a route answers: a JSON body, or a status with one. */
export type Answer = unknown | { readonly status: number; readonly body: unknown };
export type Route = Answer | ((call: Call) => Answer | Promise<Answer>);

const isStatus = (answer: unknown): answer is { status: number; body: unknown } =>
  typeof answer === "object" && answer !== null && "status" in answer && "body" in answer && Object.keys(answer).length === 2;

export interface FakeServer {
  /** Every request made so far, in order. */
  readonly calls: Call[];
  /** The requests made to one route, by "METHOD /path". */
  sent(route: string): Call[];
  /** Answer a route from now on (replacing what it answered before). */
  on(route: string, answer: Route): void;
  restore(): void;
}

/**
 * Stand in for the server: `routes` maps "METHOD /path" to its answer. A
 * path's query is ignored when matching. A request nothing answers is a 404
 * that names itself, and is listed in `calls` like any other, so a test can
 * assert that a screen asked for nothing it should not have.
 */
export const fakeServer = (routes: Record<string, Route> = {}): FakeServer => {
  const table = new Map(Object.entries(routes));
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = raw.replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: Call = { method, url, body };
    calls.push(call);
    const route = table.get(`${method} ${url.split("?")[0]}`);
    const answer = route === undefined ? { status: 404, body: { error: `nothing answers ${method} ${url}` } } : typeof route === "function" ? await (route as (call: Call) => Answer)(call) : route;
    const status = isStatus(answer) ? answer.status : 200;
    const payload = isStatus(answer) ? answer.body : answer;
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    calls,
    sent: (route) => calls.filter((call) => `${call.method} ${call.url.split("?")[0]}` === route),
    on: (route, answer) => {
      table.set(route, answer);
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
};

export interface Mounted {
  readonly container: HTMLElement;
  unmount(): void;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

export const mount = (element: ReactElement): Mounted => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  const entry = { root, container };
  mounted.push(entry);
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      mounted.splice(mounted.indexOf(entry), 1);
    },
  };
};

/** Take down everything still mounted: call it in `afterEach`. */
export const unmountAll = (): void => {
  for (const one of [...mounted]) {
    act(() => one.root.unmount());
    one.container.remove();
  }
  mounted.length = 0;
};

/** Let requests answer and the screen draw what came back. */
export const settle = async (turns = 6): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const textOf = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim();

/** Every element matching `selector` whose text contains `text`. */
export const allWith = (within: ParentNode, selector: string, text: string | RegExp): HTMLElement[] =>
  [...within.querySelectorAll<HTMLElement>(selector)].filter((element) => (typeof text === "string" ? textOf(element).includes(text) : text.test(textOf(element))));

/** The one such element; a test that names something absent, or ambiguous, fails here saying what was on screen. */
export const oneWith = (within: ParentNode, selector: string, text: string | RegExp): HTMLElement => {
  const found = allWith(within, selector, text);
  /* The innermost match: a button inside a matching wrapper is the button meant. */
  const innermost = found.filter((element) => !found.some((other) => other !== element && element.contains(other)));
  if (innermost.length !== 1) {
    const shown = [...within.querySelectorAll(selector)].map(textOf).filter(Boolean).slice(0, 30).join(" | ");
    throw new Error(`expected one ${selector} with ${String(text)}, found ${innermost.length}. On screen: ${shown}`);
  }
  return innermost[0]!;
};

/** A button by what it says, or by its `aria-label`. */
export const button = (within: ParentNode, name: string | RegExp): HTMLButtonElement => {
  const matches = (value: string) => (typeof name === "string" ? value.includes(name) : name.test(value));
  const found = [...within.querySelectorAll<HTMLButtonElement>("button")].filter((one) => matches(textOf(one)) || matches(one.getAttribute("aria-label") ?? ""));
  if (found.length !== 1) {
    const shown = [...within.querySelectorAll("button")].map((one) => textOf(one) || one.getAttribute("aria-label") || "").filter(Boolean).slice(0, 40).join(" | ");
    throw new Error(`expected one button "${String(name)}", found ${found.length}. Buttons: ${shown}`);
  }
  return found[0]!;
};

export const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
  });
  await settle(3);
};

/**
 * Type into a field the way React sees typing: the element's own value
 * setter, then an `input` event. Writing `.value` directly is ignored by a
 * controlled input.
 */
export const type = async (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> => {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};

/** Submit a form as pressing its submit button does. */
export const submit = async (form: HTMLFormElement): Promise<void> => {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle(3);
};

/** Everything a person could read on the screen, as one line. */
export const shown = (within: Element): string => textOf(within);
