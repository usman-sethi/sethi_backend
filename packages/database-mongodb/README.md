# @sethi-backend/database-mongodb

MongoDB 7 adapter and repositories for users, refresh sessions, and one-time
authentication action tokens.

```ts
import {
  createMongoDatabaseAdapter,
  createMongoAuthUserRepository,
} from "@sethi-backend/database-mongodb";
```

Transactions used for email verification, password reset, and role changes
require a replica set. See the [deployment guide](https://github.com/usman-sethi/sethi_backend/blob/main/docs/deployment.md)
before running a production deployment.
