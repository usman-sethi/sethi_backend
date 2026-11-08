# @sethi-backend/security

Argon2id password hashing and JOSE-backed access/refresh token primitives.

```ts
import {
  createPasswordHasher,
  createTokenService,
} from "@sethi-backend/security";
```

Provide a strong secret from protected configuration. Do not log or persist
raw refresh tokens; use the auth session repository to persist their hashes.
