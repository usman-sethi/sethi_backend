# Authentication guide

The Basic API combines the auth service, MongoDB repositories, a Fastify
adapter, and an injected email sender. See the [example application](../examples/basic-api/src/index.ts)
for the complete wiring.

## Browser request setup

Cookie-authenticated `POST` routes require a CSRF token. Fetch `GET /csrf-token`,
retain the returned cookie, and send the returned `token` as `X-CSRF-Token`.
Keep cookies enabled on cross-origin requests and configure the exact web
origin in `CORS_ORIGINS`.

## Account and session flow

1. `POST /auth/register` with `{ "email": "...", "password": "..." }`.
   It returns a generic `202`; it does not create a session.
2. Read the verification token from the email link's URL fragment and send it
   to `POST /auth/verify-email` as `{ "token": "..." }`.
3. `POST /auth/login` with CSRF protection. The response contains an access
   token and public user; the refresh token is only in an HttpOnly cookie.
4. Send `Authorization: Bearer <access-token>` to protected API routes.
   `GET /auth/me` returns the current public profile.
5. `POST /auth/refresh` with the refresh cookie and CSRF token to rotate the
   session token. Reuse of a consumed token revokes that session.
6. `POST /auth/logout` revokes the cookie's session. `POST /auth/logout-all`
   requires a bearer token and CSRF token and revokes all user sessions.

Refresh cookies use `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
They are scoped to `/auth`. Access tokens are bound to a persistent session;
checking a revoked, expired, missing, or unverified account denies access.

## Verification and password reset

Configure `SMTP_HOST`, `EMAIL_FROM`, and `APP_BASE_URL` to deliver account
messages. The token is placed in the URL fragment so browsers do not send it
with ordinary HTTP requests or include it in server access logs. The frontend
must read the fragment and POST the token in JSON.

`POST /auth/resend-verification` and `POST /auth/forgot-password` return generic
responses to avoid disclosing whether an account exists. `POST
/auth/reset-password` accepts `{ "token": "...", "newPassword": "..." }`.
Password reset consumes the token, changes the Argon2id hash, and revokes all
active sessions in one MongoDB transaction. The token is one-time and expires;
expired tokens are rejected even before TTL cleanup.

Delivery is direct SMTP, not a durable outbox. If delivery fails, the API
records a sanitized security event and the user can request another message.

## Roles

Roles are stored in MongoDB and loaded for protected requests; JWT role claims
are not trusted. `user` can access the profile, `moderator` is granted user
read/manage and session-revocation permissions, and `admin` can also manage
roles. The example currently exposes user listing and role management; an
application must add a route before a permission can authorize an operation.
Admin role changes are audited and transactional. The final administrator
cannot be demoted.

Provision the first administrator locally, after verifying the account:

```powershell
pnpm --filter @sethi-backend/example-basic-api build
pnpm --filter @sethi-backend/example-basic-api admin:promote -- --email admin@example.com
```

The command requires an interactive exact-email confirmation. There is no
unauthenticated HTTP promotion endpoint.
