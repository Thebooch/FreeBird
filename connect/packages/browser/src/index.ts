/**
 * Reading documentation sites that are drawn in the browser.
 *
 * Pass a `BrowserDocsRenderer` to the engine as its `renderDocs`. It drives a
 * headless Chromium through `playwright-core`, downloading the browser once
 * when asked; without this package the engine skips browser-drawn docs.
 */
export * from "./browser.js";
export * from "./tooling.js";
