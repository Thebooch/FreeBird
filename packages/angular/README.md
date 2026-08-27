# @freebirdai/angular

Angular 17+ bindings for [FreeBird](../../README.md). Provides `provideFreeBird()` DI setup, a signals-based `FreeBirdService`, and standalone headless components.

Requires **Angular >= 17** (tested against Angular 17, 18, 19, and 20) and **RxJS >= 7.5** as peer dependencies.

## Install

```bash
pnpm add @freebirdai/core @freebirdai/angular
# your app should already have @angular/core, @angular/common, rxjs
```

## Quick start

```typescript
// main.ts
import { bootstrapApplication } from "@angular/platform-browser";
import { provideFreeBird } from "@freebirdai/angular";
import { ComponentRegistry } from "@freebirdai/core";
import { AppComponent } from "./app/app.component";

const registry = new ComponentRegistry();
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
  providers: [provideFreeBird({ registry })],
});
```

```typescript
// app.component.ts
import { Component, inject } from "@angular/core";
import {
  ChatPanelComponent,
  ChatPanelFormComponent,
  ChatPanelInputComponent,
  ChatPanelMessagesComponent,
  ChatPanelMessageComponent,
  ChatPanelSubmitComponent,
  DynamicGridComponent,
  FreeBirdService,
} from "@freebirdai/angular";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [
    ChatPanelComponent,
    ChatPanelMessagesComponent,
    ChatPanelMessageComponent,
    ChatPanelFormComponent,
    ChatPanelInputComponent,
    ChatPanelSubmitComponent,
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
      <ng-template let-cell="cell">
        <!-- render your components by cell.componentId -->
      </ng-template>
    </fb-dynamic-grid>
  `,
})
export class AppComponent {
  fb = inject(FreeBirdService);
}
```

## What's included

- `provideFreeBird({ registry, transport?, ... })` — standalone DI setup
- `FreeBirdService` — signals for `sessionId`, `layout`, `tabs`, `messages`, `streaming`, `streamingText`, `lockedCells`, `actionState`, `actionPhase`, `pendingAction`, `actionJournal`, `pausedActions`, `activeComponentIds`
- Components:
  - `fb-chat-panel` / `fb-chat-panel-messages` / `fb-chat-panel-form` / `[fbChatPanelInput]` / `[fbChatPanelSubmit]` / `fb-chat-panel-message`
  - `fb-dynamic-grid` (layout bindings; bring your own drag-and-drop if needed — see note below)
  - `fb-lock-toggle`
  - `fb-info-trigger`
  - `fb-custom-tab-bar` / `fb-custom-tab-bar-list` / `fb-custom-tab-bar-item` / `fb-custom-tab-bar-save`
  - `fb-freebird-nav-links`
  - `fb-action-preview` / `fb-action-journal`

All components stamp the same `data-freebird-*` attributes as the React and Vue packages so you can share styling.

## DynamicGrid: bring your own drag-and-drop

`fb-dynamic-grid` ships layout data binding (positions, locked state) but not drag-and-drop. No single Angular grid library has the maturity of `react-grid-layout` — pick one of these depending on your needs:

- `@angular/cdk/drag-drop` — low-level, Angular-native
- `angular-gridster2` — most popular community option

Use `FreeBirdService.layout()` and `FreeBirdService.toggleLock()` to wire your chosen library in.

## Wiring the InfoTrigger → Chat explanation

Unlike React/Vue, Angular does not auto-wire this (the lifetimes are explicit). Add one line to your root component or a shared effect:

```typescript
ngOnInit() {
  this.fb.onExplain((id) => this.fb.explain(id));
}
```

## Actions

> **When to read this:** you want the chat to *do* things on the user's
> behalf. For the full how-to read [`/ACTIONS.md`](../../ACTIONS.md);
> this section is the Angular-only cheat sheet.

### Symbols covered

- Signals on `FreeBirdService`: `actionState`, `actionPhase`,
  `pendingAction`, `actionJournal`, `pausedActions`,
  `activeComponentIds`.
- Methods on `FreeBirdService`: `setActiveComponentIds`,
  `confirmAction`, `cancelAction`, `pauseAction`, `resumeAction`,
  `discardActionRecord`, `mergeActionArgs`, `onActionEvent`.
- Components: `<fb-action-preview>`, `<fb-action-journal>`.
- Re-exported types: `ActionDefinition`, `ActionState`, `ActionRecord`,
  `PendingAction`, `ConfirmationPolicy`, `PreviewStrategy`, `ActionEvent`.

### Tell FreeBird which components are active

```typescript
ngOnInit() {
  this.fb.setActiveComponentIds(["settings", "profile"]);
}
ngOnDestroy() {
  this.fb.setActiveComponentIds([]);
}
```

### Confirm before applying

```typescript
import { ActionPreviewComponent } from "@freebirdai/angular";

@Component({
  standalone: true,
  imports: [ActionPreviewComponent],
  template: `
    <fb-action-preview hideWhileExecuting>
      <ng-template
        let-pending="pending"
        let-phase="phase"
        let-error="error"
        let-confirm="confirm"
        let-cancel="cancel"
        let-pause="pause"
      >
        <my-dialog>
          <h2>{{ pending.label || pending.componentId + ':' + pending.actionId }}</h2>
          <pre>{{ pending.args | json }}</pre>
          <p *ngIf="error" role="alert">{{ error }}</p>
          <button [disabled]="phase === 'executing'" (click)="confirm()">Apply</button>
          <button (click)="cancel('user')">Cancel</button>
          <button (click)="pause()">Pause</button>
        </my-dialog>
      </ng-template>
    </fb-action-preview>
  `,
})
export class MyShellComponent {}
```

### Show paused / completed history

```typescript
import { ActionJournalComponent } from "@freebirdai/angular";

@Component({
  standalone: true,
  imports: [ActionJournalComponent],
  template: `
    <fb-action-journal [status]="'paused'">
      <ng-template let-records="records" let-resume="resume" let-discard="discard">
        <ul>
          <li *ngFor="let r of records">
            {{ r.label || r.componentId + ':' + r.actionId }}
            <button (click)="resume(r.id)">Resume</button>
            <button (click)="discard(r.id)">×</button>
          </li>
        </ul>
      </ng-template>
    </fb-action-journal>
  `,
})
export class MyJournalComponent {}
```

### Audit / undo

The journal is in-memory. Subscribe to events and persist what you care
about:

```typescript
import { Component, DestroyRef, inject } from "@angular/core";
import { FreeBirdService } from "@freebirdai/angular";

@Component({ /* … */ })
export class AuditWatcher {
  private readonly fb = inject(FreeBirdService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    const off = this.fb.onActionEvent((e) => {
      if (e.kind === "action.executed") {
        myUndoToast.show({ before: e.before, changed: e.changed });
      }
    });
    this.destroyRef.onDestroy(off);
  }
}
```

See [`/ACTIONS.md`](../../ACTIONS.md) for the full event list and the
server-side `onActionEvent` hook.

## Architecture

All streaming / SSE logic lives in [`@freebirdai/core-state`](../core-state) — this package is a thin Angular Signals projection over it.
