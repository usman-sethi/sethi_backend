# @sethi-backend/auth

Authentication services, session and action-token contracts, email delivery
contracts, and persistent-role authorization helpers.

```ts
import {
  createAuthService,
  createAuthenticationGuard,
  requirePermission,
} from "@sethi-backend/auth";
```

Inject storage, password hashing, token, and email adapters. See the
[authentication guide](https://github.com/usman-sethi/sethi_backend/blob/main/docs/authentication.md)
for account verification, password reset, session, and RBAC behavior.
