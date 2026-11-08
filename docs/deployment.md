# Deployment guide

Sethi Backend is a release candidate, not yet a production-certified service.
Run the real integration suites against disposable services and review the
[security limitations](security.md) before exposing it publicly.

## Runtime and build

Supported Node.js ranges follow the MongoDB driver: `^22.12.0`, `^24.0.0`, or
`>=26.0.0`. The repository uses pnpm `12.18.0`.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Prepare `.env` from `.env.example`, then set every production-required value
listed in the [environment reference](../README.md#environment-variables).
Never include `.env` in an image or commit it. The example runs from the
workspace after the build:

```bash
pnpm --filter @sethi-backend/example-basic-api start
```

The example's `start` script reads `../../.env` relative to the package
directory. A production process manager or container should inject environment
variables through its secret mechanism instead.

## MongoDB

Use an authenticated, network-restricted MongoDB replica set. Verification,
password reset, and RBAC changes use transactions. Ensure deployment backups
are enabled and periodically test restore procedures. Index setup occurs before
the HTTP server starts; role and action-token indexes are created by the app.

`GET /health` is a liveness probe and does not check dependencies.
`GET /ready` pings MongoDB and returns `503` when it is unavailable. Neither
probe includes connection details.

## HTTPS, cookies, and origins

Terminate HTTPS at a trusted edge and forward traffic only from known
infrastructure. Cookies are marked Secure in production. The application does
not trust forwarded headers by default; do not enable proxy trust broadly.
Set `CORS_ORIGINS` to the exact HTTPS browser origins that need credentialed
requests. Do not use `*`.

## SMTP

Use authenticated SMTP with TLS. With `SMTP_SECURE=true`, configure implicit
TLS (commonly port 465). Otherwise production requires STARTTLS (commonly port
587). Restrict credentials to the application and rotate them. The application
does not maintain a durable mail outbox, so a process failure can delay email;
users can request a new verification or reset email.

## Process lifecycle and operations

The example handles `SIGINT` and `SIGTERM`, stops Fastify, then disconnects
MongoDB. Shutdown errors set a non-zero process exit code. Use a process
manager with a termination grace period long enough for active HTTP requests
and database operations to finish.

Structured logs contain request IDs, route templates, status codes, durations,
and sanitized error metadata. Protect log storage and avoid adding secrets or
request bodies. The built-in rate limiter is process-local; there is no shared
rate-limit-store adapter yet, so do not horizontally scale and assume globally
enforced limits.
