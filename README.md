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

## Docker

`compose.yaml` runs the API with PostgreSQL 18.6. The database password is read from a Docker secret file, and `schema.sql` is applied the first time the database volume is created.

```bash
bun -e "await Bun.write('secrets/postgres_password.txt', crypto.getRandomValues(new Uint8Array(24)).toHex())"
docker compose up -d --build --wait
curl http://localhost:3000/health
```

- The API is on `localhost:${API_PORT:-3000}`; Postgres is published only on `127.0.0.1:${POSTGRES_PORT:-5432}` (user and database `scheduler`).
- `CORS_ORIGINS` is taken from your shell or `.env`, defaulting to `http://localhost:5173`.
- Data lives in the `pgdata` volume mounted at `/var/lib/postgresql` (PostgreSQL 18 images keep `PGDATA` in `/var/lib/postgresql/18/docker`). `docker compose down -v` deletes it; schema changes to `schema.sql` only apply to a fresh volume.
