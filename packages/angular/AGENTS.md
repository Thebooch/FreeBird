# @freebirdai/angular — AI integration guide

Instructions for an AI assistant adding FreeBird's Angular UI to a host app.

## What this is

Angular 17+ bindings: `provideFreeBird()` DI setup, a signals-based `FreeBirdService`, and standalone headless components over `@freebirdai/core-state`. Components stamp the same `data-freebird-*` attributes as the React/Vue packages.

Requires **Angular ≥ 17** (tested 17–20) and **RxJS ≥ 7.5**. The server half is `@freebirdai/server` — wire it first.

## Install

```bash
pnpm add @freebirdai/angular @freebirdai/core
# @angular/core, @angular/common, rxjs should already exist in the app
```

## Minimal integration

1. Register components and provide FreeBird at bootstrap (ids MUST match the server registry):

```typescript
// main.ts
import { bootstrapApplication } from "@angular/platform-browser";
import { provideFreeBird } from "@freebirdai/angular";
import { createComponentRegistry } from "@freebirdai/core";
import { AppComponent } from "./app/app.component";

const registry = createComponentRegistry();
registry.register({
  id: "revenueChart",
  title: "Revenue chart",
  description: "Monthly revenue for the current year",
  grid: {
    sizes: [
      { name: "compact", w: 4, h: 2, aspect: "wide" },
      { name: "half",    w: 6, h: 3, aspect: "wide" },
      { name: "full",    w: 12, h: 4, aspect: "wide" },
    ],
    preferredSize: "half",
  },
});

bootstrapApplication(AppComponent, {
  providers: [provideFreeBird({ registry })], // transport? for custom baseUrl/auth
});
```

2. Compose the UI with the standalone components:

```typescript
import { Component, inject } from "@angular/core";
import {
  ChatPanelComponent, ChatPanelMessagesComponent, ChatPanelMessageComponent,
  ChatPanelFormComponent, ChatPanelInputComponent, ChatPanelSubmitComponent,
  DynamicGridComponent, FreeBirdService,
} from "@freebirdai/angular";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [
    ChatPanelComponent, ChatPanelMessagesComponent, ChatPanelMessageComponent,
    ChatPanelFormComponent, ChatPanelInputComponent, ChatPanelSubmitComponent,
    DynamicGridComponent,
  ],
  template: `
    <fb-chat-panel>
      <fb-chat-panel-messages>
        <ng-template let-messages="messages" let-streamingText="streamingText">
          <fb-chat-panel-message *ngFor="let m of messages" [message]="m" />
          <div *ngIf="streamingText">{{ streamingText }}</div>
        </ng-template>
      </fb-chat-panel-messages>
      <fb-chat-panel-form #form>
        <input fbChatPanelInput [form]="form" placeholder="Ask anything..." />
        <button fbChatPanelSubmit [form]="form">Send</button>
      </fb-chat-panel-form>
    </fb-chat-panel>
    <fb-dynamic-grid>
      <ng-template let-cell="cell"><!-- render by cell.componentId --></ng-template>
    </fb-dynamic-grid>
  `,
})
export class AppComponent {
  fb = inject(FreeBirdService);
  ngOnInit() {
    this.fb.onExplain((id) => this.fb.explain(id)); // InfoTrigger → chat (not auto-wired in Angular)
  }
}
```

3. If using actions — scope per view, add `<fb-action-preview>`:

```typescript
ngOnInit()   { this.fb.setActiveComponentIds(["settings"]); }
ngOnDestroy() { this.fb.setActiveComponentIds([]); }
```

## Key APIs

- `provideFreeBird({ registry, transport?, ... })`
- `FreeBirdService` signals: `sessionId`, `layout`, `tabs`, `messages`, `streaming`, `streamingText`, `lockedCells`, `actionState`, `actionPhase`, `pendingAction`, `actionJournal`, `pausedActions`, `activeComponentIds`
- `FreeBirdService` methods: `send`, `explain`, `onExplain`, `setActiveComponentIds`, `confirmAction`, `cancelAction`, `pauseAction`, `resumeAction`, `discardActionRecord`, `mergeActionArgs`, `onActionEvent`, `toggleLock`, `layout()`
- Components: `fb-chat-panel` family, `fb-dynamic-grid`, `fb-lock-toggle`, `fb-info-trigger`, `fb-custom-tab-bar` family, `fb-action-preview`, `fb-action-journal`, `fb-freebird-nav-links`

## Works with

- `@freebirdai/server` — transport defaults to `/freebird`.
- `@angular/cdk/drag-drop` or `angular-gridster2` — `fb-dynamic-grid` ships layout data binding but NOT drag-and-drop; wire one of these via `layout()`/`toggleLock()`.

## Common pitfalls

- **InfoTrigger clicks do nothing** → Angular does not auto-wire explain; add `this.fb.onExplain((id) => this.fb.explain(id))` once.
- **Expecting built-in drag-and-drop** → bring your own grid library (see above).
- **Client/server id drift** → identical component ids on both registries; enforce with `freebird check`.
- **Audit listener leaks** → `onActionEvent` returns an unsubscribe; hand it to `DestroyRef.onDestroy(off)`.

## Verify

Run the app, send a message, and confirm the SSE stream renders and `fb-dynamic-grid` receives a layout, with no console errors.
