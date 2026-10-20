import { SQL } from "bun";

const sql = new SQL({ connection: { TimeZone: "UTC" } });
const corsOrigins = Bun.env.CORS_ORIGINS?.split(",") ?? [];

type ProcessRequest = {
  pid: number;
  name: string | null;
  user?: string | null;
  description?: string | null;
  priority: number;
  cpuUsagePercent?: number | null;
  memoryUsageBytes?: number | null;
};
type CatalogRequest = {
  name: string | null;
  capturedAt: string;
  selectionOrder: string | null;
  processes: (ProcessRequest | null)[] | null;
};
type Field = [key: string, type: string, valid: (value: unknown) => boolean];

const problemJson = { "Content-Type": "application/problem+json" };
const sections = { 400: "15.5.1", 404: "15.5.5", 405: "15.5.6", 415: "15.5.16", 500: "15.6.1" };
const hex = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes)).toHex();

const problem = (status: keyof typeof sections, title: string, extra = {}, headers?: Record<string, string>) =>
  Response.json(
    {
      type: `https://tools.ietf.org/html/rfc9110#section-${sections[status]}`,
      title,
      status,
      ...extra,
      traceId: `00-${hex(16)}-${hex(8)}-00`,
    },
    { status, headers },
  );
const validation = (errors: Record<string, string[]>) =>
  problem(400, "One or more validation errors occurred.", { errors });
const notFound = () => problem(404, "Not Found", {}, problemJson);
const catalogNotFound = (number: bigint) =>
  problem(404, "Catalog not found", { detail: `Catalog ${number} does not exist.` });

const cors =
  <T extends Request>(handler: (req: T) => Promise<Response>) =>
  async (req: T) => {
    const res = await handler(req);
    const origin = req.headers.get("origin");
    if (origin && corsOrigins.includes(origin)) {
      res.headers.set("Access-Control-Allow-Origin", origin);
      res.headers.set("Access-Control-Expose-Headers", "Location");
    }
    return res;
  };

function parseCatalogNumber(raw: string) {
  if (!/^[+-]?\d+$/.test(raw)) return notFound();
  const number = BigInt(raw);
  if (number > 9223372036854775807n || number < -9223372036854775808n) return notFound();
  if (number < 1n) return validation({ number: ["The field number must be between 1 and 9223372036854775807."] });
  return number;
}

const isText = (value: unknown) => value === null || typeof value === "string";
const isInt64 = (value: unknown) => Number.isSafeInteger(value);
const isDate = (value: unknown) => {
  const match =
    typeof value === "string" &&
    /^(\d{4})-(\d{2})-(\d{2})(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-](0\d|1[0-4]):[0-5]\d)?)?$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!));
  return date.getUTCMonth() === +match[2]! - 1 && date.getUTCDate() === +match[3]!;
};

const catalogFields: Field[] = [
  ["name", "System.String", isText],
  ["capturedAt", "System.DateTimeOffset", isDate],
  ["selectionOrder", "System.String", isText],
  ["processes", "Scheduler.Api.Contracts.ProcessSnapshotRequest[]", value => value === null || Array.isArray(value)],
];
const processFields: Field[] = [
  ["pid", "System.Int64", isInt64],
  ["name", "System.String", isText],
  ["user", "System.String", isText],
  ["description", "System.String", isText],
  ["priority", "System.Int32", value => Number.isInteger(value) && Math.abs(value as number) <= 2147483647],
  ["cpuUsagePercent", "System.Double", value => value === null || typeof value === "number"],
  ["memoryUsageBytes", "System.Int64", value => value === null || isInt64(value)],
];

function jsonError(value: unknown, path: string, type: string, fields: Field[], required: string[]) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return [path, `The JSON value could not be converted to ${type}. Path: ${path}.`] as const;
  for (const [key, fieldType, valid] of fields)
    if (key in value && !valid(value[key as keyof typeof value]))
      return [`${path}.${key}`, `The JSON value could not be converted to ${fieldType}. Path: ${path}.${key}.`] as const;
  const missing = required.filter(key => !(key in value));
  if (missing.length)
    return [
      path,
      `JSON deserialization for type '${type}' was missing required properties including: ${missing.map(key => `'${key}'`).join(", ")}.`,
    ] as const;
}

const server = Bun.serve({
  routes: {
    "/api/catalogs": {
      GET: cors(async req => {
        const query = new URL(req.url).searchParams;
        const errors: Record<string, string[]> = {};
        const [page = 1, pageSize = 20] = (
          [
            ["page", 1, 1_000_000],
            ["pageSize", 20, 100],
          ] as const
        ).map(([key, defaultValue, max]) => {
          const raw = query.get(key);
          if (raw === null) return defaultValue;
          const value = Number(raw);
          if (raw === "") errors[key] = ["The value '' is invalid."];
          else if (!/^\s*[+-]?\d+\s*$/.test(raw) || Math.abs(value) > 2147483647) errors[key] = [`The value '${raw}' is not valid.`];
          else if (value < 1 || value > max) errors[key] = [`The field ${key} must be between 1 and ${max}.`];
          return value;
        });
        if (Object.keys(errors).length) return validation(errors);

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
        if (!/^application\/([^;\s]+\+)?json\s*(;|$)/i.test(req.headers.get("content-type") ?? ""))
          return problem(415, "Unsupported Media Type", {}, problemJson);

        const requestRequired = ["The request field is required."];
        let body: unknown;
        try {
          body = await req.json();
        } catch (error) {
          return validation({ request: requestRequired, $: [(error as Error).message] });
        }
        const readError =
          jsonError(body, "$", "Scheduler.Api.Contracts.CreateCatalogRequest", catalogFields, [
            "name",
            "capturedAt",
            "selectionOrder",
            "processes",
          ]) ??
          (body as CatalogRequest).processes
            ?.map((process, i) =>
              process === null
                ? undefined
                : jsonError(process, `$.processes[${i}]`, "Scheduler.Api.Contracts.ProcessSnapshotRequest", processFields, [
                    "pid",
                    "name",
                    "priority",
                  ]),
            )
            .find(Boolean);
        if (readError) return validation({ request: requestRequired, [readError[0]]: [readError[1]] });

        const { name, capturedAt, selectionOrder, processes } = body as CatalogRequest;
        const errors: Record<string, string[]> = {};
        const add = (key: string, message: string) => (errors[key] ??= []).push(message);

        if (!name?.trim()) add("Name", "The Name field is required.");
        if (name !== null && (name.length < 1 || name.length > 200))
          add("Name", "The field Name must be a string with a minimum length of 1 and a maximum length of 200.");
        if (processes === null) add("Processes", "The Processes field is required.");
        else if (processes.length < 1)
          add("Processes", "The field Processes must be a string or array type with a minimum length of '1'.");
        else if (processes.length > 10000)
          add("Processes", "The field Processes must be a string or array type with a maximum length of '10000'.");
        else if (processes.includes(null)) add("Processes", "Snapshots cannot be null.");
        else {
          (processes as ProcessRequest[]).forEach((process, i) => {
            const key = `Processes[${i}]`;
            if (process.pid < 0 || process.pid > 4294967295)
              add(`${key}.Pid`, "The field Pid must be between 0 and 4294967295.");
            if (!process.name?.trim()) add(`${key}.Name`, "The Name field is required.");
            if (process.name !== null && (process.name.length < 1 || process.name.length > 260))
              add(`${key}.Name`, "The field Name must be a string with a minimum length of 1 and a maximum length of 260.");
            if (process.user != null && process.user.length > 256)
              add(`${key}.User`, "The field User must be a string with a maximum length of 256.");
            if (process.priority < 0 || process.priority > 1)
              add(`${key}.Priority`, "The field Priority must be between 0 and 1.");
            if (process.description != null && process.description.length > 10000)
              add(`${key}.Description`, "The field Description must be a string with a maximum length of 10000.");
            if (process.cpuUsagePercent != null && (process.cpuUsagePercent < 0 || process.cpuUsagePercent > 100))
              add(`${key}.CpuUsagePercent`, "The field CpuUsagePercent must be between 0 and 100.");
            if (process.memoryUsageBytes != null && process.memoryUsageBytes < 0)
              add(`${key}.MemoryUsageBytes`, "The field MemoryUsageBytes must be between 0 and 9223372036854775807.");
          });
          if (new Set(processes.map(process => process!.pid)).size !== processes.length)
            add("Processes", "Each PID may appear only once within a catalog.");
        }
        if (!selectionOrder?.trim()) add("SelectionOrder", "The SelectionOrder field is required.");
        else if (!/^(cpu|memory)$/.test(selectionOrder))
          add("SelectionOrder", "The field SelectionOrder must match the regular expression '^(cpu|memory)$'.");
        if (Object.keys(errors).length) return validation(errors);

        const rows = (processes as ProcessRequest[]).map((process, position) => ({
          position,
          pid: process.pid,
          name: process.name,
          user: process.user?.trim() ? process.user : null,
          description: process.description ?? null,
          priority: process.priority,
          cpuUsagePercent: process.cpuUsagePercent ?? null,
          memoryUsageBytes: process.memoryUsageBytes ?? null,
        }));
        const [{ catalog }] = await sql`
          WITH catalog AS (
            INSERT INTO catalogs (name, captured_at, selection_order, process_count)
            VALUES (${name!.trim()}, ${capturedAt}::timestamptz, ${selectionOrder}, ${rows.length})
            RETURNING *
          ), inserted AS (
            INSERT INTO processes (catalog_number, position, pid, name, user_name, description, priority, cpu_usage_percent, memory_usage_bytes)
            SELECT catalog.number, p.*
            FROM catalog, json_to_recordset(${rows}::json) AS p(
              position int, pid bigint, name text, "user" text, description text,
              priority smallint, "cpuUsagePercent" float8, "memoryUsageBytes" bigint
            )
          )
          SELECT json_build_object(
            'number', number, 'name', name, 'capturedAt', captured_at, 'createdAt', created_at,
            'selectionOrder', selection_order, 'processCount', process_count
          ) AS catalog
          FROM catalog`;
        return Response.json(
          { ...catalog, processes: rows },
          { status: 201, headers: { Location: `/api/catalogs/${catalog.number}` } },
        );
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
        return row ? Response.json(row.catalog) : catalogNotFound(number);
      }),

      DELETE: cors(async req => {
        const number = parseCatalogNumber(req.params.number);
        if (number instanceof Response) return number;

        const [deleted] = await sql`DELETE FROM catalogs WHERE number = ${number} RETURNING number`;
        return deleted ? new Response(null, { status: 204 }) : catalogNotFound(number);
      }),
    },

    "/health": {
      GET: cors(async () => {
        try {
          await sql`SELECT 1`;
          return Response.json({ status: "ready" });
        } catch {
          return Response.json({ status: "unavailable" }, { status: 503 });
        }
      }),
    },
  },

  fetch(req) {
    const requestMethod = req.headers.get("access-control-request-method");
    if (req.method === "OPTIONS" && requestMethod) {
      const origin = req.headers.get("origin");
      const headers = new Headers();
      if (origin && corsOrigins.includes(origin)) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Allow-Methods", requestMethod);
        const requestHeaders = req.headers.get("access-control-request-headers");
        if (requestHeaders) headers.set("Access-Control-Allow-Headers", requestHeaders);
      }
      return new Response(null, { status: 204, headers });
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
    return allow ? problem(405, "Method Not Allowed", {}, { ...problemJson, Allow: allow }) : notFound();
  },

  error(error) {
    console.error(error);
    return problem(500, "An error occurred while processing your request.", {}, problemJson);
  },
});

console.log(`Process Catalog API listening on ${server.url}`);
