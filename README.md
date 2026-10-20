# scheduler-api

Process Catalog API ([OpenAPI](https://api-schedule.salesconnect.dev/openapi/v1.json)) on Bun 1.4.3 and PostgreSQL.

```bash
bun install
psql "$DATABASE_URL" -f schema.sql
bun dev      # or: bun start
```

Environment (`.env`):

- `DATABASE_URL`: PostgreSQL connection string.
- `PORT`: optional, defaults to 3000.

CORS is open: any browser origin may call the API (`Access-Control-Allow-Origin: *`).

Type check with `bun check`.

## Docker

`compose.yaml` runs the API with PostgreSQL 18.6. The database password is read from a Docker secret file, and `schema.sql` is applied the first time the database volume is created.

```bash
bun -e "await Bun.write('secrets/postgres_password.txt', crypto.getRandomValues(new Uint8Array(24)).toHex())"
docker compose up -d --build --wait
curl http://localhost:3000/health
```

- The API is on `localhost:${API_PORT:-3000}`; Postgres is published only on `127.0.0.1:${POSTGRES_PORT:-5432}` (user and database `scheduler`).
- Data lives in the `pgdata` volume mounted at `/var/lib/postgresql` (PostgreSQL 18 images keep `PGDATA` in `/var/lib/postgresql/18/docker`). `docker compose down -v` deletes it; schema changes to `schema.sql` only apply to a fresh volume.

## CI/CD

`.github/workflows/ci-cd.yml` runs on every pull request and push to `main`:

1. **build**: `bun check`, builds the image, starts it with Postgres via `compose.yaml`, and smoke-tests the API (create, read, list, delete a catalog). On `main` it pushes `ghcr.io/<owner>/scheduler-api:sha-<commit>` and `:latest`.
2. **deploy** (`main` only, `production` environment): copies `compose.yaml`, `compose.prod.yaml`, `Caddyfile`, `schema.sql` and `deploy/remote-deploy.sh` to `/opt/scheduler` on the VPS over SSH, pulls the new image and runs `docker compose up --wait`. If the new release doesn't become healthy, it rolls back to the previous image. It then checks `https://$API_DOMAIN/health`.

In production, `compose.prod.yaml` adds Caddy, which terminates TLS (automatic Let's Encrypt certificates) and proxies to the API. The API port isn't published, and Postgres listens only on the VPS's `127.0.0.1:5432`.

The VPS is prepared once with `deploy/bootstrap-vps.sh`. It installs Docker, creates a `deploy` user (Docker access, no sudo) that authorizes the given public key, and generates the database password in `/opt/scheduler/secrets/`:

```bash
scp deploy/bootstrap-vps.sh ubuntu@<vps>:/tmp/
ssh ubuntu@<vps> "sudo bash /tmp/bootstrap-vps.sh '<deploy public key>'"
```

GitHub configuration (Settings → Environments → `production`):

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `VPS_SSH_KEY` | Private key matching the deploy public key |
| Variable | `VPS_HOST` | VPS IP or hostname |
| Variable | `VPS_KNOWN_HOSTS` | `known_hosts` line for the VPS (`<host> ssh-ed25519 AAAA...`) |
| Variable | `API_DOMAIN` | Public domain pointing at the VPS, e.g. `api-schedule.salesconnect.dev` |
| Variable | `VPS_USER` | Optional, defaults to `deploy` |

Run commands on the server as `deploy` from `/opt/scheduler` (for example `docker compose ps` or `docker compose logs -f api`). The `.env` there selects both compose files.
