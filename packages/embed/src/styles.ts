/**
 * Widget CSS, injected into the shadow root — host pages can't break it and
 * it can't break them. Theme via CSS custom properties on the host element:
 *
 *   freebird-chat { --freebird-accent: #b4231f; --freebird-radius: 8px; }
 */
export const WIDGET_CSS = `
:host {
  --fb-accent: var(--freebird-accent, #2563eb);
  --fb-bg: var(--freebird-bg, #ffffff);
  --fb-text: var(--freebird-text, #111827);
  --fb-muted: var(--freebird-muted, #6b7280);
  --fb-border: var(--freebird-border, #e5e7eb);
  --fb-radius: var(--freebird-radius, 14px);
  --fb-font: var(--freebird-font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  all: initial;
  font-family: var(--fb-font);
  position: fixed;
  z-index: 2147483000;
  bottom: 20px;
}
:host([data-position="bottom-right"]) { right: 20px; }
:host([data-position="bottom-left"]) { left: 20px; }

/* Full mode: the host spans the entire viewport edge-to-edge instead of a
   corner bubble, so the sidebar panel and its edge tab can anchor to it. */
:host([data-position="full-right"]),
:host([data-position="full-left"]) {
  bottom: 0; top: 0;
}
:host([data-position="full-right"]) { right: 0; }
:host([data-position="full-left"]) { left: 0; }

* { box-sizing: border-box; }
button { font-family: inherit; cursor: pointer; }

.launcher {
  width: 56px; height: 56px; border-radius: 50%;
  border: none; background: var(--fb-accent); color: #fff;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 8px 24px rgba(0,0,0,0.22);
  transition: transform .15s ease;
}
.launcher:hover { transform: scale(1.06); }
.launcher svg { width: 26px; height: 26px; fill: currentColor; }

/* Full mode replaces the circular bubble with a slim tab fixed to the
   viewport edge, vertically centered, hidden once the panel is open. */
:host([data-position^="full-"]) .launcher {
  width: 40px; height: 128px; border-radius: 0;
  position: fixed; top: 50%; transform: translateY(-50%);
}
:host([data-position="full-right"]) .launcher { right: 0; border-radius: 10px 0 0 10px; }
:host([data-position="full-left"]) .launcher { left: 0; border-radius: 0 10px 10px 0; }
:host([data-position^="full-"]) .launcher:hover { transform: translateY(-50%) scale(1.04); }
:host([data-position^="full-"][data-open]) .launcher { display: none; }

.panel {
  position: absolute; bottom: 72px; width: 372px; max-width: calc(100vw - 32px);
  height: 540px; max-height: calc(100vh - 120px);
  display: none; flex-direction: column; overflow: hidden;
  background: var(--fb-bg); color: var(--fb-text);
  border: 1px solid var(--fb-border); border-radius: var(--fb-radius);
  box-shadow: 0 16px 48px rgba(0,0,0,0.24);
}
:host([data-position="bottom-right"]) .panel { right: 0; }
:host([data-position="bottom-left"]) .panel { left: 0; }
:host([data-open]) .panel { display: flex; }

/* Full mode: always in the layout (display: flex) so the transform can
   animate; visibility is purely a slide off/on-screen via translateX. */
:host([data-position^="full-"]) .panel {
  position: fixed; top: 0; bottom: 0; right: auto; left: auto;
  width: 380px; max-width: 90vw; height: 100%; max-height: 100%;
  border-radius: 0; display: flex;
  transition: transform .25s ease;
}
:host([data-position="full-right"]) .panel { right: 0; transform: translateX(100%); }
:host([data-position="full-left"]) .panel { left: 0; transform: translateX(-100%); }
:host([data-position^="full-"][data-open]) .panel { transform: translateX(0); }

.header {
  padding: 14px 16px; background: var(--fb-accent); color: #fff;
  display: flex; align-items: center; justify-content: space-between;
  font-size: 15px; font-weight: 600;
}
.header button {
  background: none; border: none; color: #fff; font-size: 18px; line-height: 1;
  padding: 2px 6px; opacity: .85;
}
.header button:hover { opacity: 1; }

.messages {
  flex: 1; overflow-y: auto; padding: 14px;
  display: flex; flex-direction: column; gap: 10px;
  font-size: 14px; line-height: 1.45;
}
.msg { max-width: 85%; padding: 9px 12px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
.msg.user { align-self: flex-end; background: var(--fb-accent); color: #fff; border-bottom-right-radius: 4px; }
.msg.assistant { align-self: flex-start; background: #f3f4f6; color: var(--fb-text); border-bottom-left-radius: 4px; }
.msg.card {
  align-self: flex-start; width: 100%; max-width: 100%;
  background: var(--fb-bg); border: 1px solid var(--fb-border); border-left: 3px solid var(--fb-accent);
}
.msg.card .card-title { font-weight: 600; margin-bottom: 4px; font-size: 13px; }
.typing { align-self: flex-start; color: var(--fb-muted); font-size: 13px; padding: 2px 4px; }

.citations { align-self: flex-start; display: flex; flex-wrap: wrap; gap: 6px; margin-top: -4px; }
.citation-chip {
  border: 1px solid var(--fb-accent); border-radius: 999px; background: var(--fb-bg);
  color: var(--fb-accent); font-size: 12px; font-weight: 500; padding: 4px 10px;
  display: inline-flex; align-items: center; gap: 4px; transition: background .12s ease;
}
.citation-chip::before { content: "↳"; font-size: 12px; }
.citation-chip:hover { background: var(--fb-accent); color: #fff; }

.confirm {
  margin: 0 14px 10px; padding: 12px; font-size: 13px;
  border: 1px solid var(--fb-border); border-radius: 10px; background: #fafafa;
}
.confirm .confirm-title { font-weight: 600; margin-bottom: 6px; }
.confirm .confirm-rows { color: var(--fb-muted); margin-bottom: 10px; white-space: pre-wrap; word-break: break-word; }
.confirm .confirm-actions { display: flex; gap: 8px; }
.confirm button {
  border-radius: 8px; padding: 7px 14px; font-size: 13px; border: 1px solid var(--fb-border);
  background: var(--fb-bg); color: var(--fb-text);
}
.confirm button.primary { background: var(--fb-accent); border-color: var(--fb-accent); color: #fff; }

.composer {
  display: flex; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--fb-border);
}
.composer input {
  flex: 1; border: 1px solid var(--fb-border); border-radius: 10px;
  padding: 10px 12px; font-size: 14px; font-family: inherit; color: var(--fb-text);
  background: var(--fb-bg); outline: none;
}
.composer input:focus { border-color: var(--fb-accent); }
.composer button {
  border: none; border-radius: 10px; background: var(--fb-accent); color: #fff;
  padding: 0 16px; font-size: 14px; font-weight: 600;
}
.composer button:disabled { opacity: .5; cursor: default; }

.footer { text-align: center; font-size: 11px; color: var(--fb-muted); padding: 0 0 8px; }
.footer a { color: inherit; }
`;
