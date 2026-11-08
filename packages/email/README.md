# @sethi-backend/email

SMTP `EmailSender` implementation backed by Nodemailer.

```ts
import { createSmtpEmailSender } from "@sethi-backend/email";
```

Set `requireTLS: true` when using STARTTLS, and use `secure: true` for implicit
TLS. Keep credentials in protected runtime configuration; never log messages
containing account action tokens.
