# Integration and package-consumer testing

The integration command is intentionally strict: it fails before test
collection if MongoDB, Redis, SMTP, Mailpit, or the test-only environment is missing.
It never silently skips tests. It runs seven MongoDB persistence/security
tests, one real-MongoDB HTTP authentication workflow, and one SMTP delivery
test that queries Mailpit to verify both messages and their contents.

MongoDB test targets must be local and the base database name must end in
`_integration_test`. Each MongoDB suite creates a unique database and drops
only that database. The package-consumer check also uses a unique disposable
database and drops it after its real HTTP workflow. Never use production or
shared database credentials or hosts.

## Docker Compose (recommended)

The compose file starts:

- MongoDB 8 as a single-node transaction-capable replica set on localhost.
- Redis for cross-instance rate-limit integration tests.
- Mailpit SMTP and HTTP API on localhost.
- Verdaccio as a temporary local npm registry on localhost.

Start the services from the repository root:

```powershell
pnpm test:services:up
pnpm test:services:wait
```

The MongoDB container health check only verifies that `mongod` responds to a
ping. Initialize the replica set separately after the service is healthy:

```powershell
docker compose -f docker-compose.test.yml exec -T mongodb mongosh --quiet --host 127.0.0.1 --port 27017 --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  $primary = docker compose -f docker-compose.test.yml exec -T mongodb mongosh --quiet --host 127.0.0.1 --port 27017 --eval 'db.hello().isWritablePrimary'
  if ($LASTEXITCODE -eq 0 -and $primary -contains "true") { break }
  Start-Sleep -Seconds 1
}
if ($primary -notcontains "true") { throw "MongoDB did not become writable primary." }
```

Set explicit test-only variables and run all ten integration tests:

```powershell
$env:TEST_MONGODB_URI = "mongodb://127.0.0.1:27017/?replicaSet=rs0"
$env:TEST_MONGODB_DATABASE = "sethi_backend_integration_test"
$env:TEST_REDIS_URL = "redis://127.0.0.1:6379/0"
$env:SMTP_TEST_ENABLED = "true"
$env:SMTP_HOST = "127.0.0.1"
$env:SMTP_PORT = "1025"
$env:SMTP_SECURE = "false"
$env:EMAIL_FROM = "no-reply@example.test"
$env:TEST_SMTP_RECIPIENT = "integration@example.test"
$env:MAILPIT_API_URL = "http://127.0.0.1:8025"
pnpm test:integration
```

Expected result: 4 test files and 10 tests pass, with no skips. The SMTP test
sends verification and reset fixtures through Nodemailer to Mailpit, then
confirms both messages were actually received at the designated test address.
The MongoDB tests exercise indexes, token expiry/consumption, refresh rotation
and replay, concurrent refresh, transactional password reset/verification,
session revocation, RBAC, and the HTTP routes. The Redis integration test
verifies that two independent Fastify instances share a route-specific limit.

## Independent package consumer

With the same MongoDB/Mailpit services running and variables configured, run:

```powershell
pnpm validate:packages
```

The command builds all seven packages, creates tarballs, publishes them only
to the loopback Verdaccio registry, and installs them in a clean temporary npm
project outside the workspace. It compiles TypeScript against the installed
declarations, starts a real Fastify API, checks its MongoDB health endpoint,
delivers a verification email through SMTP, and exercises verification, login,
profile access, and RBAC. The script refuses non-loopback registries and
MongoDB/SMTP targets. It never uses the public npm registry for package
publishing. To reset the local registry between package-version attempts:

```powershell
pnpm test:services:down
pnpm test:services:up
```

## Without Docker

Install MongoDB Community Server plus `mongosh`, and run a local single-node
replica set bound to loopback:

```powershell
New-Item -ItemType Directory -Force C:\data\sethi-mongodb-test | Out-Null
mongod --dbpath C:\data\sethi-mongodb-test --bind_ip 127.0.0.1 --port 27017 --replSet rs0
```

Initialize it once:

```powershell
mongosh "mongodb://127.0.0.1:27017" --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})"
```

Wait until `mongosh "mongodb://127.0.0.1:27017" --quiet --eval
"db.hello().isWritablePrimary"` returns `true` before starting the tests.
Run a local Redis server on `127.0.0.1:6379` as well.

Run Mailpit with SMTP on `127.0.0.1:1025` and its HTTP API on
`127.0.0.1:8025`. For the package-consumer test, also run Verdaccio locally
using `config/verdaccio.yaml` on `127.0.0.1:4873`. Then set the same variables
above and run the test commands. A single MongoDB server without replica-set
transactions is not sufficient.

## CI

`.github/workflows/release-validation.yml` starts the same compose services
and runs frozen installation, build, unit tests, all integration tests, the
independent package consumer, package dry-runs, dependency auditing, and
`git diff --check`. It uses only synthetic `.test` addresses and no secrets.
The MongoDB health check only tests `mongod` ping responsiveness. CI initializes
`rs0` in a separate step with member `127.0.0.1:27017` and waits for
`db.hello().isWritablePrimary` before running tests. On failure, the workflow
prints Compose status, MongoDB container logs, image/runner architecture, and
AVX/AVX2 availability before removing the services.
