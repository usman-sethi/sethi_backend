# @sethi-backend/adapter-fastify

Fastify 5 adapter for `@sethi-backend/core`, with request IDs, sanitized
unhandled-error responses, structured duration logs, and security helpers.

```ts
import {
  createFastifyAdapter,
  registerHttpSecurity,
} from "@sethi-backend/adapter-fastify";
```

Register HTTP security before routes. The adapter does not enable proxy trust;
configure trusted proxies explicitly in a deployment that requires them.
