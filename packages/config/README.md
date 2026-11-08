# @sethi-backend/config

Small Zod-based environment configuration loader.

```ts
import { loadConfig } from "@sethi-backend/config";
```

Pass a Zod schema and a readonly string environment map. Failures use
`ConfigValidationError` and identify fields and constraints without echoing
input values. The Basic API's complete application schema lives in the example
package.
