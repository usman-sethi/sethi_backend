# Security guide

## Production configuration

Set `NODE_ENV=production` and explicitly configure:

- A random `JWT_SECRET` of at least 32 characters. Do not use the example
  placeholder, a repeated character, or a low-diversity string.
- A non-development `MONGODB_DATABASE` and a credential-protected MongoDB URI.
- Exact HTTPS `CORS_ORIGINS` values; wildcard and opaque `null` origins are
  rejected.
- `SMTP_HOST`, `EMAIL_FROM`, and an HTTPS `APP_BASE_URL`. Configure SMTP
  authentication as a pair when required. SMTP uses implicit TLS when
  `SMTP_SECURE=true`; otherwise the production adapter requires STARTTLS.

Never put credentials in source control or paste them into logs. Use a secret
manager or protected environment injection.

## HTTP protections

- Refresh tokens are HttpOnly cookies; production cookies are Secure and
  SameSite=Lax. Browser cookie-authenticated POST requests use CSRF protection.
- CORS only grants configured origins. The adapter does not enable
  `trustProxy`; forwarded addresses and scheme headers must not be trusted
  unless the deployment has explicitly configured known proxy addresses.
- Login, registration, verification, resend, and reset endpoints have
  per-process rate limits. The in-memory limiter is not a shared distributed
  store; multi-instance deployments need a shared rate-limit implementation
  before relying on these limits.
- Helmet security headers are enabled by the Fastify security registration.

## Authentication and persistence

Action tokens are random, hashed at rest, purpose-tagged, expiring, and consumed
once. Password resets revoke sessions transactionally. Refresh rotation records
consumed hashes and treats reuse as replay. MongoDB TTL indexes clean up old
records but are not used as the authorization-time expiration check.

Transactions for verification, password reset, and role changes require MongoDB
replica-set support, including a single-node replica set. A standalone MongoDB
server is not sufficient.

## Logs and errors

Fastify creates a server-side request ID and returns it in `X-Request-Id`.
Completion logs include the ID, route, status, and duration. Unhandled 5xx
errors are logged with an error class name, not a raw message or stack. Public
error responses use a stable `{ "error": { "code", "message", "requestId" } }`
shape and do not expose exception details.

The Fastify logger redacts authorization/cookie headers, set-cookie values,
passwords, tokens, and SMTP passwords. Application auth events contain only
safe event metadata and identifiers. Do not add request bodies, raw error
objects, tokens, database URIs, or SMTP settings to log fields.
