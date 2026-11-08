# @sethi-backend/core

Framework-neutral application lifecycle and adapter contracts.

```ts
import { createBackend } from "@sethi-backend/core";
```

`createBackend` connects the database before starting the HTTP adapter and
stops the adapter before disconnecting the database. See `BackendConfig` and
the [deployment guide](https://github.com/usman-sethi/sethi_backend/blob/main/docs/deployment.md)
for lifecycle expectations.
