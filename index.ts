import { SQL } from "bun";

const sql = new SQL({ connection: { TimeZone: "UTC" } });

type ProcessRequest = {
  pid: number;
  name: string;
  user?: string | null;
  description?: string | null;
  priority: number;
  cpuUsagePercent?: number | null;
  memoryUsageBytes?: number | null;
};
type CatalogRequest = {
  name: string;
  capturedAt: string;
  selectionOrder: string;
  processes: ProcessRequest[];
};

const empty = (status: number, headers?: ResponseInit["headers"]) => new Response(null, { status, headers });

const cors =
  <T extends Request>(handler: (req: T) => Promise<Response>) =>
  async (req: T) => {
    const res = await handler(req);
    res.headers.set("Access-Control-Allow-Origin", "*");
    res.headers.set("Access-Control-Expose-Headers", "Location");
    return res;
  };

function parseCatalogNumber(raw: string) {
  if (!/^[+-]?\d+$/.test(raw)) return empty(404);
  const number = BigInt(raw);
  if (number > 9223372036854775807n || number < -9223372036854775808n) return empty(404);
  if (number < 1n) return empty(400);
  return number;
}

function parsePageParam(query: URLSearchParams, key: string, defaultValue: number, max: number) {
  const raw = query.get(key);
  if (raw === null) return defaultValue;
  const value = Number(raw);
  return /^\s*[+-]?\d+\s*$/.test(raw) && value >= 1 && value <= max ? value : null;
}

const isDate = (value: unknown) => {
  const match =
    typeof value === "string" &&
    /^(\d{4})-(\d{2})-(\d{2})(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-](0\d|1[0-4]):[0-5]\d)?)?$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!));
  return date.getUTCMonth() === +match[2]! - 1 && date.getUTCDate() === +match[3]!;
};
const isName = (value: unknown, max: number) => typeof value === "string" && value.trim() !== "" && value.length <= max;
const isOptionalText = (value: unknown, max: number) => value == null || (typeof value === "string" && value.length <= max);

const isProcess = (p: any): p is ProcessRequest =>
  Number.isInteger(p?.pid) &&
  p.pid >= 0 &&
  p.pid <= 4294967295 &&
  isName(p.name, 260) &&
  isOptionalText(p.user, 256) &&
  isOptionalText(p.description, 10000) &&
  (p.priority === 0 || p.priority === 1) &&
  (p.cpuUsagePercent == null ||
    (typeof p.cpuUsagePercent === "number" && p.cpuUsagePercent >= 0 && p.cpuUsagePercent <= 100)) &&
  (p.memoryUsageBytes == null || (Number.isSafeInteger(p.memoryUsageBytes) && p.memoryUsageBytes >= 0));

const isCatalog = (c: any): c is CatalogRequest =>
  isName(c?.name, 200) &&
  isDate(c.capturedAt) &&
  (c.selectionOrder === "cpu" || c.selectionOrder === "memory") &&
  Array.isArray(c.processes) &&
  c.processes.length >= 1 &&
  c.processes.length <= 10000 &&
  c.processes.every(isProcess) &&
  new Set(c.processes.map((p: ProcessRequest) => p.pid)).size === c.processes.length;

const server = Bun.serve({
  routes: {
    "/api/catalogs": {
      GET: cors(async req => {
        const query = new URL(req.url).searchParams;
        const page = parsePageParam(query, "page", 1, 1_000_000);
        const pageSize = parsePageParam(query, "pageSize", 20, 100);
        if (page === null || pageSize === null) return empty(400);

        const [{ items, totalCount }] = await sql`
          SELECT
            (SELECT count(*)::int FROM catalogs) AS "totalCount",
            (SELECT coalesce(json_agg(c ORDER BY c.number DESC), '[]') FROM (
              SELECT number, name, captured_at AS "capturedAt", created_at AS "createdAt",
                     selection_order AS "selectionOrder", process_count AS "processCount"
              FROM catalogs
              ORDER BY number DESC
              LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
            ) c) AS items`;
        return Response.json({ items, totalCount, page, pageSize });
      }),

      POST: cors(async req => {
        if (!/^application\/([^;\s]+\+)?json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) return empty(415);
        const body = await req.json().catch(() => null);
        if (!isCatalog(body)) return empty(400);

        const { name, capturedAt, selectionOrder, processes } = body;
        const rows = processes.map((process, position) => ({
          position,
          pid: process.pid,
          name: process.name,
          user: process.user?.trim() ? process.user : null,
          description: process.description ?? null,
          priority: process.priority,
          cpuUsagePercent: process.cpuUsagePercent ?? null,
          memoryUsageBytes: process.memoryUsageBytes ?? null,
        }));
        const [{ number }] = await sql`
          WITH catalog AS (
            INSERT INTO catalogs (name, captured_at, selection_order, process_count)
            VALUES (${name.trim()}, ${capturedAt}::timestamptz, ${selectionOrder}, ${rows.length})
            RETURNING number
          ), inserted AS (
            INSERT INTO processes (catalog_number, position, pid, name, user_name, description, priority, cpu_usage_percent, memory_usage_bytes)
            SELECT catalog.number, p.*
            FROM catalog, json_to_recordset(${rows}::json) AS p(
              position int, pid bigint, name text, "user" text, description text,
              priority smallint, "cpuUsagePercent" float8, "memoryUsageBytes" bigint
            )
          )
          SELECT number FROM catalog`;
        return empty(201, { Location: `/api/catalogs/${number}` });
      }),
    },

    "/api/catalogs/:number": {
      GET: cors(async req => {
        const number = parseCatalogNumber(req.params.number);
        if (number instanceof Response) return number;

        const [row] = await sql`
          SELECT json_build_object(
            'number', c.number, 'name', c.name, 'capturedAt', c.captured_at, 'createdAt', c.created_at,
            'selectionOrder', c.selection_order, 'processCount', c.process_count,
            'processes', (SELECT coalesce(json_agg(p ORDER BY p.position), '[]') FROM (
              SELECT position, pid, name, user_name AS "user", description, priority,
                     cpu_usage_percent AS "cpuUsagePercent", memory_usage_bytes AS "memoryUsageBytes"
              FROM processes
              WHERE catalog_number = c.number
            ) p)
          ) AS catalog
          FROM catalogs c
          WHERE c.number = ${number}`;
        return row ? Response.json(row.catalog) : empty(404);
      }),

      DELETE: cors(async req => {
        const number = parseCatalogNumber(req.params.number);
        if (number instanceof Response) return number;

        const [deleted] = await sql`DELETE FROM catalogs WHERE number = ${number} RETURNING number`;
        return empty(deleted ? 204 : 404);
      }),
    },

    "/health": {
      GET: cors(async () => {
        try {
          await sql`SELECT 1`;
          return empty(200);
        } catch {
          return empty(503);
        }
      }),
    },
  },

  fetch(req) {
    const requestMethod = req.headers.get("access-control-request-method");
    if (req.method === "OPTIONS" && requestMethod) {
      const headers = new Headers({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": requestMethod,
      });
      const requestHeaders = req.headers.get("access-control-request-headers");
      if (requestHeaders) headers.set("Access-Control-Allow-Headers", requestHeaders);
      return empty(204, headers);
    }

    const { pathname } = new URL(req.url);
    const allow =
      pathname === "/api/catalogs"
        ? "GET, POST"
        : /^\/api\/catalogs\/[+-]?\d+$/.test(pathname)
          ? "DELETE, GET"
          : pathname === "/health"
            ? "GET"
            : null;
    return allow ? empty(405, { Allow: allow }) : empty(404);
  },

  error(error) {
    console.error(error);
    return empty(500);
  },
});

console.log(`Process Catalog API listening on ${server.url}`);
