# @freebirdai/connect-sandbox

Where `@freebirdai/connect` runs connector code it wrote for an API that needs
more than a declared request. Each run gets a fresh QuickJS interpreter,
compiled to WebAssembly, in a worker thread of its own; the code can only
compute and ask its host.

```ts
import { QuickJsSandbox } from "@freebirdai/connect-sandbox";
// pass `new QuickJsSandbox()` as the engine's connector sandbox
```

Without this package the engine refuses generated connector code.
