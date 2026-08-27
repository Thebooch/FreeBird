# @freebirdai/adapters-email-resend

[Resend](https://resend.com) adapter for FreeBird digests.

```ts
import { createResendAdapter } from "@freebirdai/adapters-email-resend";

const email = createResendAdapter({
  apiKey: process.env.RESEND_API_KEY,
  from: "digests@yourdomain.com",
});
```
