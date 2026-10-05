# @freebirdai/connect-browser

Reads API documentation that only appears once a browser runs the page's
scripts. Drives a headless Chromium through `playwright-core`; the browser
itself is a one-time download, made only when somebody agrees to it.

```ts
import { BrowserDocsRenderer, RendererTooling } from "@freebirdai/connect-browser";
```

Without this package the engine skips documentation that is drawn in the
browser and says so.
