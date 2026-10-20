# scheduler-api

Process Catalog API ([OpenAPI](https://api-schedule.salesconnect.dev/openapi/v1.json)) on Bun 1.4.3 and PostgreSQL.

```bash
bun install
psql "$DATABASE_URL" -f schema.sql
bun dev      # or: bun start
```

Environment (`.env`):

- `DATABASE_URL`: PostgreSQL connection string.
- `CORS_ORIGINS`: comma-separated browser origins allowed to call the API.
- `PORT`: optional, defaults to 3000.

Type check with `bun check`.
