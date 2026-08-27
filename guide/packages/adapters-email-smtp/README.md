# @freebirdai/adapters-email-smtp

SMTP email adapter (via nodemailer) for FreeBird digests.

```ts
import { createSmtpAdapter } from "@freebirdai/adapters-email-smtp";

const email = createSmtpAdapter({
  from: "digests@example.com",
  transport: {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "...", pass: "..." },
  },
});
```
