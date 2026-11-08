# Workspace packages

Each package is ESM-only and exports its built public entry point and
declarations from `dist`. Consumers should import from the package root, not
from internal `src` paths.

| Package | Public entry point |
| :--- | :--- |
| `@sethi-backend/core` | `createBackend`, lifecycle and adapter contracts |
| `@sethi-backend/adapter-fastify` | Fastify adapter, HTTP security and CSRF helpers |
| `@sethi-backend/config` | Zod-based `loadConfig` utility |
| `@sethi-backend/security` | Password hashing and token services |
| `@sethi-backend/auth` | Authentication service, guard, permissions and contracts |
| `@sethi-backend/database-mongodb` | MongoDB adapter and authentication repositories |
| `@sethi-backend/email` | Nodemailer-backed SMTP `EmailSender` |

Build before packing. From the repository root, inspect each publishable
package with `pnpm --dir packages/core pack --dry-run` (replace `core` with
each package directory). Package manifests restrict published files to build
output; package-level README files describe the supported entry point.

All packages are currently version `0.1.0`. Internal workspace dependencies
are declared with `workspace:*` and are rewritten to matching package versions
when packed. Those packages must be published together or installed from a
registry that contains the complete compatible set. No package is published
by the build or test commands.
