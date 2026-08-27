---
title: Recipes
---

# Recipes

### Using FreeBird's components inside your existing navbar

```tsx
import { FreeBirdNavLinks } from "@freebirdai/react";

<MyNavbar>
  <HomeLink />
  <FreeBirdNavLinks>
    {({ tab, onClick }) => (
      <NavLink key={tab.id} to={`/tabs/${tab.slug ?? tab.id}`} onClick={onClick}>
        {tab.title}
      </NavLink>
    )}
  </FreeBirdNavLinks>
  <SettingsLink />
</MyNavbar>
```

### Hiding lock chrome on a "static" tab

```tsx
<DynamicGrid showLocks={false} />
```

### Custom info-button icon

```tsx
<InfoTrigger componentId="revenueChart" asChild>
  <button className="my-btn"><HelpCircleIcon /></button>
</InfoTrigger>
```

### Rate-limiting the API

```ts
import { rateLimit } from "@freebirdai/server/middleware";
app.use("/freebird", rateLimit({ windowMs: 60_000, max: 30 }), createFreeBirdRouter(opts));
```

### Moving digests to the standalone worker

```ts
// In your API: disable the in-process scheduler.
createFreeBirdRouter({ ...opts, scheduler: "external" });

// In a separate process:
new DigestWorker({ ...opts, tickMs: 60_000 }).start();
```
