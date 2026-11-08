# Troubleshooting

## Application exits before listening

Production mode validates the secret, MongoDB database name, CORS allowlist,
and SMTP settings at startup. Check field names in the validation error and
compare them with [.env.example](../.env.example). Startup errors intentionally
omit raw connection strings and exception messages from logs.

## `/ready` returns 503

`/health` only indicates that the HTTP process is alive. `/ready` performs a
MongoDB ping. Check the service's protected MongoDB diagnostics, network
connectivity, TLS/certificate setup, and credentials without printing the URI
or password into logs.

## Verification, reset, or role change fails

These operations require transactions. Ensure MongoDB is a replica set (a
single-node replica set works for local testing) and that the configured user
has the required permissions. TTL cleanup is asynchronous; an expired token is
still rejected immediately.

## No email arrives

Confirm `SMTP_HOST`, `EMAIL_FROM`, and `APP_BASE_URL` are set; SMTP credentials
must be paired. Production requires HTTPS for `APP_BASE_URL` and TLS for SMTP.
Delivery failures are logged as `auth.email.delivery_failed` with an account
identifier, not the message, address, token, or credentials. Request a new
message after fixing transport configuration.

For local SMTP smoke tests, set `SMTP_TEST_ENABLED=true` and a dedicated
`TEST_SMTP_RECIPIENT`. The integration test refuses to run without the
explicit recipient.

## Browser POST requests fail CSRF validation

Fetch `/csrf-token`, retain its cookie, and send the returned token in
`X-CSRF-Token` together with the cookie. For cross-origin browser clients,
enable credentialed requests and allow the exact origin in `CORS_ORIGINS`.
`X-Request-Id` can be read by allowed origins for support correlation.

## Integration suites are skipped

`pnpm test:integration` requires `TEST_MONGODB_URI` and
`TEST_MONGODB_DATABASE` ending in `_integration_test`, pointed at a local
replica-set MongoDB instance. It uses unique disposable database names and
drops only those databases. If MongoDB or SMTP is unavailable, the suite
reports skips; these are not evidence of live service verification.
