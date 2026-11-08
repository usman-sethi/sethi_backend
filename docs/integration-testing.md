# Integration testing

The integration suites are separate from the unit suite. They only target
`localhost`, require a disposable database name ending in
`_integration_test`, create a unique database per test file, and drop only
that unique database after the run. Never use a shared or production database.

## Local MongoDB replica set

Install MongoDB Community Server and `mongosh`. In PowerShell, create a
dedicated data directory and start a local single-node replica set:

```powershell
New-Item -ItemType Directory -Force C:\data\sethi-mongodb-test | Out-Null
mongod --dbpath C:\data\sethi-mongodb-test --bind_ip 127.0.0.1 --port 27017 --replSet rs0
```

In another PowerShell window, initialize the replica set once:

```powershell
mongosh "mongodb://127.0.0.1:27017" --eval "rs.initiate()"
```

Then run the real database and HTTP workflow suites:

```powershell
$env:TEST_MONGODB_URI = "mongodb://127.0.0.1:27017/?replicaSet=rs0"
$env:TEST_MONGODB_DATABASE = "sethi_backend_integration_test"
pnpm test:integration
```

Tests cover MongoDB persistence, indexes and duplicate emails; token
expiration/consumption; transactional password reset and verification;
refresh rotation, replay and concurrency; session revocation; RBAC updates; and
the HTTP authentication workflow. Transactions require the replica set.

## SMTP smoke test

For local delivery, run a local-only SMTP test service such as Mailpit. Keep its
SMTP and web interfaces bound to localhost. In a separate PowerShell window,
configure its SMTP port and a designated test recipient:

```powershell
$env:SMTP_TEST_ENABLED = "true"
$env:SMTP_HOST = "127.0.0.1"
$env:SMTP_PORT = "1025"
$env:SMTP_SECURE = "false"
$env:EMAIL_FROM = "no-reply@example.test"
$env:TEST_SMTP_RECIPIENT = "test-recipient@example.test"
pnpm test:integration
```

The SMTP suite sends both verification and password-reset fixtures only to
`TEST_SMTP_RECIPIENT`. It is skipped unless explicitly enabled. Use a local
test service or a provider sandbox; do not use a real user's address.
