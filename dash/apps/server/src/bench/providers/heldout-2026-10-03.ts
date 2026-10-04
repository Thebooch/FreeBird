import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";
import { BENCH_NOW, html, json, notFound, pick, random } from "../seed.js";

/**
 * Held-out provider written 2026-10-03 by a separate author, to replace
 * trackwell (studied and moved to dev). Its author did not read the
 * integration loop, the importers, the connector internals or any result.
 *
 * staffnest — an HR system, shaped like Personio's v1 API with a service user
 * signing in over HTTP Basic, as HiBob's does.
 *
 * - Every field of an employee is an envelope, `{ label, value, type,
 *   universal_id }`, under `attributes`. A department or office is two objects
 *   deeper: `attributes.department.value.attributes.name`. Fields a company
 *   added itself are keyed `dynamic_<id>`; only their label says what they are.
 * - The documentation says `offset` is a number of records to skip and tells
 *   you to add `limit` to it for the next page. It is really a 0-based page
 *   number, as the answer's own `metadata.current_page` shows. A second request
 *   at a record offset (`offset=100`) asks for page 100 and comes back empty.
 * - Former employees stay in the list (`inactive`), beside `onboarding` and
 *   `leave`, so "active" is a narrowing, not the whole list.
 */

const API = "api.staffnest.bench.test";
const DEV = "developer.staffnest.bench.test";
const SERVICE_USER = "SERVICE-31877";
const TOKEN = "sn_tok_9f3c1a7e5b2d4806a1e3c9b7d5f20481";

type Status = "active" | "inactive" | "onboarding" | "leave";

interface Department {
  readonly id: number;
  readonly name: string;
  readonly weight: number;
  readonly positions: readonly string[];
  readonly teams: readonly string[];
  readonly salary: readonly [number, number];
  readonly costCenter: string;
}

const DEPARTMENTS: readonly Department[] = [
  {
    id: 210401,
    name: "Engineering",
    weight: 30,
    positions: ["Backend Engineer", "Frontend Engineer", "Engineering Manager", "QA Engineer", "Site Reliability Engineer"],
    teams: ["Platform", "Payments", "Mobile", "Data"],
    salary: [58000, 112000],
    costCenter: "CC-4100",
  },
  {
    id: 210402,
    name: "Sales",
    weight: 18,
    positions: ["Account Executive", "Sales Development Representative", "Sales Manager"],
    teams: ["DACH", "Benelux", "Enterprise"],
    salary: [42000, 88000],
    costCenter: "CC-2100",
  },
  {
    id: 210403,
    name: "Customer Success",
    weight: 14,
    positions: ["Customer Success Manager", "Support Specialist", "Onboarding Specialist"],
    teams: ["Support", "Onboarding", "Key Accounts"],
    salary: [38000, 72000],
    costCenter: "CC-2300",
  },
  {
    id: 210404,
    name: "Marketing",
    weight: 10,
    positions: ["Content Marketer", "Performance Marketer", "Product Marketing Manager"],
    teams: ["Brand", "Growth"],
    salary: [44000, 84000],
    costCenter: "CC-2500",
  },
  {
    id: 210405,
    name: "Finance",
    weight: 8,
    positions: ["Accountant", "Financial Controller", "Payroll Specialist"],
    teams: ["Accounting", "Controlling"],
    salary: [48000, 95000],
    costCenter: "CC-3100",
  },
  {
    id: 210406,
    name: "People",
    weight: 8,
    positions: ["People Partner", "Recruiter", "People Operations Specialist"],
    teams: ["Talent", "People Ops"],
    salary: [42000, 82000],
    costCenter: "CC-3300",
  },
  {
    id: 210407,
    name: "Operations",
    weight: 12,
    positions: ["Office Manager", "Warehouse Associate", "Operations Analyst"],
    teams: ["Facilities", "Logistics"],
    salary: [34000, 70000],
    costCenter: "CC-3500",
  },
];

const OFFICES = [
  { id: 501, name: "Berlin" },
  { id: 502, name: "Munich" },
  { id: 503, name: "Amsterdam" },
  { id: 504, name: "Remote" },
] as const;

const FIRST = [
  "Lena", "Jonas", "Mia", "Felix", "Hannah", "Lukas", "Emma", "Noah", "Sofia", "Elias", "Clara", "Ben",
  "Lea", "Paul", "Marie", "Finn", "Nora", "Leon", "Ida", "Theo", "Anna", "Max", "Greta", "Emil",
] as const;

const LAST = [
  "Schmidt", "Müller", "Weber", "Fischer", "Becker", "Wagner", "Hoffmann", "Schulz", "Koch", "Richter",
  "Klein", "Wolf", "de Vries", "Jansen", "Bakker", "Visser", "Meyer", "Braun", "Krüger", "Hartmann",
] as const;

const ascii = (text: string): string =>
  text
    .toLowerCase()
    .replace(/ü/g, "ue")
    .replace(/ö/g, "oe")
    .replace(/ä/g, "ae")
    .replace(/[^a-z]/g, "");

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Personio writes dates as local midnight with the office's offset. */
const personioDate = (ms: number): string => {
  const iso = day(ms);
  const month = Number(iso.slice(5, 7));
  return `${iso}T00:00:00${month >= 4 && month <= 10 ? "+02:00" : "+01:00"}`;
};

interface Employee {
  readonly id: number;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly status: Status;
  readonly position: string;
  readonly employmentType: "internal" | "external";
  readonly weeklyHours: string;
  readonly hireDate: string;
  readonly terminationDate: string | null;
  readonly department: Department;
  readonly office: (typeof OFFICES)[number];
  readonly supervisorId: number | null;
  /** Whole euros a year; 0 for hourly (external) staff. */
  readonly fixSalary: number;
  readonly hourlySalary: number;
  readonly team: string;
  readonly lastModified: string;
}

const DAY = 86_400_000;
const EMPLOYEE_COUNT = 237;

const EMPLOYEES: readonly Employee[] = (() => {
  const next = random(20261003);
  const totalWeight = DEPARTMENTS.reduce((sum, d) => sum + d.weight, 0);
  const department = (): Department => {
    let roll = next() * totalWeight;
    for (const d of DEPARTMENTS) {
      roll -= d.weight;
      if (roll < 0) return d;
    }
    return DEPARTMENTS[DEPARTMENTS.length - 1]!;
  };
  const rows: Employee[] = [];
  for (let index = 0; index < EMPLOYEE_COUNT; index += 1) {
    const id = 4012 + index * 3 + Math.floor(next() * 3);
    const firstName = pick(next, FIRST);
    const lastName = pick(next, LAST);
    const dept = department();
    const roll = next();
    const status: Status = roll < 0.68 ? "active" : roll < 0.82 ? "inactive" : roll < 0.9 ? "onboarding" : "leave";
    const external = next() < 0.14;
    const [low, high] = dept.salary;
    const fixSalary = external ? 0 : low + Math.floor(next() * ((high - low) / 500 + 1)) * 500;
    const hourlySalary = external ? 22 + Math.floor(next() * 87) / 2 : 0;
    const hired =
      status === "onboarding"
        ? BENCH_NOW + (3 + Math.floor(next() * 60)) * DAY
        : BENCH_NOW - (30 + Math.floor(next() * 2200)) * DAY;
    const terminated =
      status === "inactive" ? Math.min(BENCH_NOW - DAY, hired + (60 + Math.floor(next() * 900)) * DAY) : null;
    const peers = rows.filter((row) => row.department.id === dept.id);
    rows.push({
      id,
      firstName,
      lastName,
      email: `${ascii(firstName)}.${ascii(lastName)}${id % 100}@nordlicht-logistik.example`,
      status,
      position: pick(next, dept.positions),
      employmentType: external ? "external" : "internal",
      weeklyHours: pick(next, ["40", "40", "40", "32", "30", "20"]),
      hireDate: personioDate(hired),
      terminationDate: terminated === null ? null : personioDate(terminated),
      department: dept,
      office: pick(next, OFFICES),
      supervisorId: peers.length === 0 ? null : pick(next, peers).id,
      fixSalary,
      hourlySalary,
      team: pick(next, dept.teams),
      lastModified: `${new Date(BENCH_NOW - Math.floor(next() * 400) * DAY - Math.floor(next() * DAY)).toISOString().slice(0, 19)}+02:00`,
    });
  }
  return rows;
})();

const BY_ID = new Map(EMPLOYEES.map((employee) => [employee.id, employee]));

// ── Answer keys: computed from the seed, never from Dash. ──────────────────

const ACTIVE_ENGINEERS = EMPLOYEES.filter(
  (employee) => employee.status === "active" && employee.department.name === "Engineering",
).length;

/*
 * The team is a field the company added itself (`dynamic_24810`, labelled
 * "Team"). A sum over salaries would suit this API too, but the scripted
 * measure's `field` reads only a top-level key and every value here sits
 * inside `attributes`, so no reference could prove one: both keys are counts.
 */
const ACTIVE_PLATFORM_TEAM = EMPLOYEES.filter(
  (employee) => employee.status === "active" && employee.team === "Platform",
).length;

// ── Rendering: every field an envelope. ────────────────────────────────────

const attribute = (label: string, value: unknown, type: string, universalId: string | null, extra = {}) => ({
  label,
  value,
  type,
  universal_id: universalId,
  ...extra,
});

const nested = (kind: string, id: number, name: string) => ({ type: kind, attributes: { id, name } });

const brief = (employee: Employee) => ({
  type: "Employee",
  attributes: {
    id: attribute("ID", employee.id, "integer", "id"),
    first_name: attribute("First name", employee.firstName, "standard", "first_name"),
    last_name: attribute("Last name", employee.lastName, "standard", "last_name"),
    email: attribute("Email", employee.email, "standard", "email"),
  },
});

const render = (employee: Employee, only: readonly string[]): unknown => {
  const supervisor = employee.supervisorId === null ? null : BY_ID.get(employee.supervisorId);
  const all: Record<string, unknown> = {
    id: attribute("ID", employee.id, "integer", "id"),
    first_name: attribute("First name", employee.firstName, "standard", "first_name"),
    last_name: attribute("Last name", employee.lastName, "standard", "last_name"),
    email: attribute("Email", employee.email, "standard", "email"),
    status: attribute("Status", employee.status, "standard", "status"),
    position: attribute("Position", employee.position, "standard", "position"),
    employment_type: attribute("Employment type", employee.employmentType, "standard", "employment_type"),
    weekly_working_hours: attribute("Weekly hours", employee.weeklyHours, "standard", "weekly_working_hours"),
    hire_date: attribute("Hire date", employee.hireDate, "date", "hire_date"),
    termination_date: attribute("Termination date", employee.terminationDate, "date", "termination_date"),
    department: attribute(
      "Department",
      nested("Department", employee.department.id, employee.department.name),
      "standard",
      "department",
    ),
    office: attribute("Office", nested("Office", employee.office.id, employee.office.name), "standard", "office"),
    supervisor: attribute("Supervisor", supervisor ? brief(supervisor) : null, "standard", "supervisor"),
    fix_salary: attribute("Fix salary", employee.fixSalary, "decimal", "fix_salary", { currency: "EUR" }),
    fix_salary_interval: attribute(
      "Salary interval",
      employee.employmentType === "internal" ? "yearly" : null,
      "standard",
      "fix_salary_interval",
    ),
    hourly_salary: attribute("Hourly salary", employee.hourlySalary, "decimal", "hourly_salary", { currency: "EUR" }),
    last_modified_at: attribute("Last modified", employee.lastModified, "date", "last_modified_at"),
    dynamic_24810: attribute("Team", employee.team, "list", null),
    dynamic_24811: attribute("Cost center", employee.department.costCenter, "standard", null),
  };
  const attributes =
    only.length === 0
      ? all
      : Object.fromEntries(Object.entries(all).filter(([key]) => key === "id" || only.includes(key)));
  return { type: "Employee", attributes };
};

// ── Time off: a second, differently shaped list (plain values, enveloped employee). ──

const TIME_OFF_TYPES = [
  { id: 880101, name: "Paid vacation", category: "paid_vacation" },
  { id: 880102, name: "Sick leave", category: "sick_leave" },
  { id: 880103, name: "Parental leave", category: "parental_leave" },
  { id: 880104, name: "Unpaid leave", category: "unpaid_leave" },
  { id: 880105, name: "Training", category: "other" },
] as const;

interface TimeOff {
  readonly id: number;
  readonly employee: Employee;
  readonly type: (typeof TIME_OFF_TYPES)[number];
  readonly status: "approved" | "pending" | "rejected";
  readonly start: number;
  readonly days: number;
  readonly created: number;
}

const TIME_OFFS: readonly TimeOff[] = (() => {
  const next = random(31002026);
  const rows: TimeOff[] = [];
  let id = 7700100;
  for (const employee of EMPLOYEES) {
    if (employee.status === "onboarding") continue;
    const periods = Math.floor(next() * 4);
    for (let n = 0; n < periods; n += 1) {
      const start = Date.UTC(2026, 0, 1) + Math.floor(next() * 300) * DAY;
      const days = 1 + Math.floor(next() * 10);
      rows.push({
        id: id++,
        employee,
        type: pick(next, [
          TIME_OFF_TYPES[0],
          TIME_OFF_TYPES[0],
          TIME_OFF_TYPES[0],
          TIME_OFF_TYPES[1],
          TIME_OFF_TYPES[1],
          TIME_OFF_TYPES[2],
          TIME_OFF_TYPES[3],
          TIME_OFF_TYPES[4],
        ]),
        status: pick(next, ["approved", "approved", "approved", "approved", "pending", "rejected"] as const),
        start,
        days,
        created: start - (5 + Math.floor(next() * 40)) * DAY,
      });
    }
  }
  return rows;
})();

const renderTimeOff = (row: TimeOff) => ({
  type: "TimeOffPeriod",
  attributes: {
    id: row.id,
    status: row.status,
    start_date: personioDate(row.start),
    end_date: personioDate(row.start + (row.days - 1) * DAY),
    days_count: row.days,
    half_day_start: 0,
    half_day_end: 0,
    time_off_type: { type: "TimeOffType", attributes: { id: row.type.id, name: row.type.name, category: row.type.category } },
    employee: brief(row.employee),
    created_at: `${new Date(row.created).toISOString().slice(0, 19)}+02:00`,
  },
});

// ── The API. ───────────────────────────────────────────────────────────────

const failure = (code: number, message: string, headers: Record<string, string> = {}): BenchResponse =>
  json({ success: false, error: { code, message } }, code, headers);

const signedIn = (request: BenchRequest): boolean => {
  const header = request.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon > 0 && decoded.slice(0, colon) === SERVICE_USER && decoded.slice(colon + 1) === TOKEN;
};

/**
 * `offset` is a 0-based page number, whatever the documentation says: the
 * page is `rows[offset * limit, offset * limit + limit)`.
 */
const paged = (request: BenchRequest, rows: readonly unknown[]): BenchResponse => {
  const params = request.url.searchParams;
  const limit = params.has("limit") ? Number(params.get("limit")) : 50;
  const offset = params.has("offset") ? Number(params.get("offset")) : 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return failure(400, "The limit must be a whole number from 1 to 200.");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return failure(400, "The offset must be a whole number of 0 or more.");
  }
  return json({
    success: true,
    metadata: {
      total_elements: rows.length,
      current_page: offset,
      total_pages: Math.ceil(rows.length / limit),
    },
    offset,
    limit,
    data: rows.slice(offset * limit, offset * limit + limit),
  });
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const api = (request: BenchRequest): BenchResponse => {
  const path = request.url.pathname.replace(/\/+$/, "");
  if (!path.startsWith("/v1/")) return failure(404, "Not found.");
  if (!signedIn(request)) {
    return failure(401, "The service user ID or token is not valid.", {
      "www-authenticate": 'Basic realm="Staffnest API"',
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return failure(405, "This endpoint only answers GET.");
  }
  const params = request.url.searchParams;

  if (path === "/v1/company/employees") {
    const email = params.get("email");
    const only = params.getAll("attributes[]");
    const rows = EMPLOYEES.filter((employee) => email === null || employee.email === email.toLowerCase());
    return paged(
      request,
      rows.map((employee) => render(employee, only)),
    );
  }

  const one = /^\/v1\/company\/employees\/(\d+)$/.exec(path);
  if (one) {
    const employee = BY_ID.get(Number(one[1]));
    if (!employee) return failure(404, "The employee was not found.");
    return json({ success: true, data: render(employee, params.getAll("attributes[]")) });
  }

  if (path === "/v1/company/time-off-types") {
    return json({
      success: true,
      data: TIME_OFF_TYPES.map((type) => ({ type: "TimeOffType", attributes: { ...type } })),
    });
  }

  if (path === "/v1/company/time-offs") {
    const start = params.get("start_date");
    const end = params.get("end_date");
    if (start === null || end === null) {
      return failure(400, "start_date and end_date are required.");
    }
    if (!DATE.test(start) || !DATE.test(end)) {
      return failure(400, "start_date and end_date must be dates written YYYY-MM-DD.");
    }
    const from = Date.parse(`${start}T00:00:00Z`);
    const to = Date.parse(`${end}T00:00:00Z`);
    const rows = TIME_OFFS.filter((row) => row.start <= to && row.start + (row.days - 1) * DAY >= from);
    return paged(request, rows.map(renderTimeOff));
  }

  return failure(404, "Not found.");
};

// ── The documentation. ─────────────────────────────────────────────────────

const EXAMPLE_EMPLOYEE = {
  type: "Employee",
  attributes: {
    id: { label: "ID", value: 1842, type: "integer", universal_id: "id" },
    first_name: { label: "First name", value: "Jana", type: "standard", universal_id: "first_name" },
    last_name: { label: "Last name", value: "Okafor", type: "standard", universal_id: "last_name" },
    email: { label: "Email", value: "jana.okafor@example.com", type: "standard", universal_id: "email" },
    status: { label: "Status", value: "active", type: "standard", universal_id: "status" },
    position: { label: "Position", value: "Payroll Specialist", type: "standard", universal_id: "position" },
    department: {
      label: "Department",
      value: { type: "Department", attributes: { id: 9001, name: "Finance" } },
      type: "standard",
      universal_id: "department",
    },
    office: {
      label: "Office",
      value: { type: "Office", attributes: { id: 12, name: "Hamburg" } },
      type: "standard",
      universal_id: "office",
    },
    hire_date: { label: "Hire date", value: "2022-02-01T00:00:00+01:00", type: "date", universal_id: "hire_date" },
    fix_salary: { label: "Fix salary", value: 61500, type: "decimal", universal_id: "fix_salary", currency: "EUR" },
    dynamic_99120: { label: "Shirt size", value: "M", type: "list", universal_id: null },
  },
};

const EXAMPLE_LIST = {
  success: true,
  metadata: { total_elements: 412, current_page: 0, total_pages: 9 },
  offset: 0,
  limit: 50,
  data: [EXAMPLE_EMPLOYEE],
};

const pretty = (value: unknown): string =>
  JSON.stringify(value, null, 2).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const DOCS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Staffnest API reference</title>
</head>
<body>
<header>
  <h1>Staffnest API reference</h1>
  <p>Read your company's people data from Staffnest: employees, their departments and offices, and time off.
  The machine-readable specification is at <a href="/docs/openapi.json">openapi.json</a>.</p>
</header>

<main>
<section id="overview">
  <h2>Overview</h2>
  <p>All requests go to <code>https://${API}/v1</code> and answer JSON. Dates are written in the
  office's local time with its offset, for example <code>2022-02-01T00:00:00+01:00</code>.</p>
</section>

<section id="authentication">
  <h2>Authentication</h2>
  <p>An admin creates a service user under <strong>Settings → Integrations → API access</strong>. Staffnest shows two
  values once: the <strong>Service user ID</strong> and its <strong>Token</strong>.</p>
  <p>Send them with HTTP Basic authentication: the service user ID is the username and the token is the password.</p>
  <pre>curl -u SERVICE-12345:sn_tok_... https://${API}/v1/company/employees</pre>
  <p>A request without valid credentials is answered <code>401</code>. What a service user may read is set by its
  permissions; attributes it may not read are left out of every record.</p>
</section>

<section id="pagination">
  <h2>Pagination</h2>
  <p>List endpoints return their records a page at a time, controlled by two query parameters:</p>
  <ul>
    <li><code>limit</code>: how many records a response holds, from 1 to 200. The default is 50.</li>
    <li><code>offset</code>: the number of records to skip before the first record returned. The default is 0.</li>
  </ul>
  <p>To read the next page, add <code>limit</code> to <code>offset</code>: <code>?limit=50&amp;offset=0</code>,
  then <code>?limit=50&amp;offset=50</code>, and so on until a response holds fewer records than <code>limit</code>.</p>
  <p>Every list response also carries <code>metadata</code>, whose <code>total_elements</code> is the number of
  records in the whole collection.</p>
</section>

<section id="attributes">
  <h2>Employee attributes</h2>
  <p>An employee is returned as <code>{ "type": "Employee", "attributes": { … } }</code>. Each attribute is an object,
  not a bare value:</p>
  <ul>
    <li><code>label</code>: the attribute's name as it is shown in Staffnest;</li>
    <li><code>value</code>: its value;</li>
    <li><code>type</code>: <code>standard</code>, <code>integer</code>, <code>decimal</code>, <code>date</code> or <code>list</code>;</li>
    <li><code>universal_id</code>: a stable name for the attributes every company has, and <code>null</code> for the
    ones a company added itself.</li>
  </ul>
  <p>Attributes your company added itself (a team, a cost center, a shirt size) are keyed <code>dynamic_&lt;id&gt;</code>.
  Their <code>label</code> is the name you gave them.</p>
  <p>A department, office or supervisor is itself an object inside <code>value</code>, for example
  <code>{ "type": "Department", "attributes": { "id": 9001, "name": "Finance" } }</code>.</p>
  <p>Money attributes (<code>fix_salary</code>, <code>hourly_salary</code>) are in euros and carry their
  <code>currency</code>. A fixed salary is a yearly amount; hourly staff have a fixed salary of 0.</p>
  <h3>Status</h3>
  <p><code>status</code> is one of <code>active</code>, <code>onboarding</code> (hired, not started yet),
  <code>leave</code> (on long-term leave) and <code>inactive</code> (left the company). People who have left stay in
  the list, with their <code>termination_date</code>.</p>
</section>

<section id="endpoints">
  <h2>Endpoints</h2>

  <h3 id="list-employees">GET /company/employees</h3>
  <p>Lists every employee, including those who have left.</p>
  <table>
    <thead><tr><th>Parameter</th><th>In</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td><code>limit</code></td><td>query</td><td>Records per response, 1–200. Default 50.</td></tr>
      <tr><td><code>offset</code></td><td>query</td><td>Records to skip before the first one returned. Default 0.</td></tr>
      <tr><td><code>email</code></td><td>query</td><td>Only the employee with this email address.</td></tr>
      <tr><td><code>attributes[]</code></td><td>query</td><td>Only these attributes, repeated once for each:
        <code>attributes[]=status&amp;attributes[]=department</code>. <code>id</code> is always returned.</td></tr>
    </tbody>
  </table>
  <p>Example response:</p>
  <pre>${pretty(EXAMPLE_LIST)}</pre>

  <h3 id="get-employee">GET /company/employees/{employee_id}</h3>
  <p>One employee, by the value of its <code>id</code> attribute. Takes <code>attributes[]</code> as above.</p>
  <pre>${pretty({ success: true, data: EXAMPLE_EMPLOYEE })}</pre>

  <h3 id="list-time-off-types">GET /company/time-off-types</h3>
  <p>The kinds of time off your company uses. Not paginated.</p>
  <pre>${pretty({
    success: true,
    data: [{ type: "TimeOffType", attributes: { id: 31, name: "Paid vacation", category: "paid_vacation" } }],
  })}</pre>

  <h3 id="list-time-offs">GET /company/time-offs</h3>
  <p>Time-off periods that overlap a date range. Paginated with <code>limit</code> and <code>offset</code> like
  employees.</p>
  <table>
    <thead><tr><th>Parameter</th><th>In</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td><code>start_date</code></td><td>query</td><td>Required. First day of the range, <code>YYYY-MM-DD</code>.</td></tr>
      <tr><td><code>end_date</code></td><td>query</td><td>Required. Last day of the range, <code>YYYY-MM-DD</code>.</td></tr>
      <tr><td><code>limit</code></td><td>query</td><td>Records per response, 1–200. Default 50.</td></tr>
      <tr><td><code>offset</code></td><td>query</td><td>Records to skip before the first one returned. Default 0.</td></tr>
    </tbody>
  </table>
  <p>A period's own attributes are plain values (<code>status</code> is <code>approved</code>,
  <code>pending</code> or <code>rejected</code>); the employee inside it is returned as on the employees endpoint.</p>
</section>

<section id="errors">
  <h2>Errors</h2>
  <p>An error answers its HTTP status and <code>{ "success": false, "error": { "code": 400, "message": "…" } }</code>.</p>
</section>
</main>
</body>
</html>`;

const attributeSchema = (description: string, value: Record<string, unknown>) => ({
  allOf: [{ $ref: "#/components/schemas/Attribute" }],
  description,
  properties: { value },
});

const pageParams = [
  {
    name: "limit",
    in: "query",
    required: false,
    description: "Records per response.",
    schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  },
  {
    name: "offset",
    in: "query",
    required: false,
    description: "The number of records to skip before the first record returned. Add `limit` to it for the next page.",
    schema: { type: "integer", minimum: 0, default: 0 },
  },
];

const listOf = (item: string) => ({
  type: "object",
  properties: {
    success: { type: "boolean" },
    metadata: { $ref: "#/components/schemas/Metadata" },
    offset: { type: "integer" },
    limit: { type: "integer" },
    data: { type: "array", items: { $ref: `#/components/schemas/${item}` } },
  },
});

const named = (kind: string) => ({
  type: "object",
  properties: {
    type: { type: "string", enum: [kind] },
    attributes: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } },
  },
});

const OPENAPI = {
  openapi: "3.0.3",
  info: {
    title: "Staffnest API",
    version: "1.0",
    description: "Read your company's people data from Staffnest. Prose reference: https://" + DEV + "/docs/api",
  },
  servers: [{ url: `https://${API}/v1` }],
  security: [{ serviceUser: [] }],
  paths: {
    "/company/employees": {
      get: {
        operationId: "listEmployees",
        summary: "List employees",
        description: "Every employee, including those who have left (status `inactive`).",
        parameters: [
          ...pageParams,
          { name: "email", in: "query", required: false, description: "Only the employee with this email.", schema: { type: "string" } },
          {
            name: "attributes[]",
            in: "query",
            required: false,
            description: "Only these attributes. `id` is always returned.",
            style: "form",
            explode: true,
            schema: { type: "array", items: { type: "string" } },
          },
        ],
        responses: {
          "200": {
            description: "A page of employees.",
            content: { "application/json": { schema: listOf("Employee"), example: EXAMPLE_LIST } },
          },
          "401": { description: "Missing or invalid credentials.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/company/employees/{employee_id}": {
      get: {
        operationId: "getEmployee",
        summary: "Get an employee",
        parameters: [
          { name: "employee_id", in: "path", required: true, schema: { type: "integer" } },
          {
            name: "attributes[]",
            in: "query",
            required: false,
            style: "form",
            explode: true,
            schema: { type: "array", items: { type: "string" } },
          },
        ],
        responses: {
          "200": {
            description: "One employee.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { success: { type: "boolean" }, data: { $ref: "#/components/schemas/Employee" } },
                },
              },
            },
          },
          "404": { description: "No such employee.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/company/time-off-types": {
      get: {
        operationId: "listTimeOffTypes",
        summary: "List time-off types",
        responses: {
          "200": {
            description: "Every time-off type. Not paginated.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    data: { type: "array", items: { $ref: "#/components/schemas/TimeOffType" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/company/time-offs": {
      get: {
        operationId: "listTimeOffs",
        summary: "List time-off periods",
        description: "Periods that overlap the range from start_date to end_date.",
        parameters: [
          { name: "start_date", in: "query", required: true, schema: { type: "string", format: "date" } },
          { name: "end_date", in: "query", required: true, schema: { type: "string", format: "date" } },
          ...pageParams,
        ],
        responses: {
          "200": {
            description: "A page of time-off periods.",
            content: { "application/json": { schema: listOf("TimeOffPeriod") } },
          },
          "400": { description: "A date is missing or malformed.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      serviceUser: {
        type: "http",
        scheme: "basic",
        description: "The service user ID as the username and its token as the password.",
      },
    },
    schemas: {
      Metadata: {
        type: "object",
        properties: {
          total_elements: { type: "integer", description: "Records in the whole collection." },
          current_page: { type: "integer" },
          total_pages: { type: "integer" },
        },
      },
      Attribute: {
        type: "object",
        description: "Every employee attribute is one of these: its label as shown in Staffnest, and its value.",
        properties: {
          label: { type: "string" },
          value: {},
          type: { type: "string", enum: ["standard", "integer", "decimal", "date", "list"] },
          universal_id: { type: "string", nullable: true },
          currency: { type: "string" },
        },
      },
      Employee: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["Employee"] },
          attributes: {
            type: "object",
            description: "Attributes a company added itself are keyed `dynamic_<id>`; their label names them.",
            properties: {
              id: attributeSchema("The employee's id.", { type: "integer" }),
              first_name: attributeSchema("First name.", { type: "string" }),
              last_name: attributeSchema("Last name.", { type: "string" }),
              email: attributeSchema("Work email.", { type: "string" }),
              status: attributeSchema("Employment status.", {
                type: "string",
                enum: ["active", "onboarding", "leave", "inactive"],
              }),
              position: attributeSchema("Job title.", { type: "string" }),
              employment_type: attributeSchema("internal or external.", { type: "string" }),
              weekly_working_hours: attributeSchema("Contracted hours a week.", { type: "string" }),
              hire_date: attributeSchema("First working day.", { type: "string" }),
              termination_date: attributeSchema("Last working day, for people who left.", { type: "string", nullable: true }),
              department: attributeSchema("The employee's department.", named("Department")),
              office: attributeSchema("The employee's office.", named("Office")),
              supervisor: attributeSchema("The employee's supervisor, as an Employee with a few attributes.", {
                type: "object",
                nullable: true,
              }),
              fix_salary: attributeSchema("Fixed salary in euros a year; 0 for hourly staff.", { type: "number" }),
              fix_salary_interval: attributeSchema("yearly", { type: "string", nullable: true }),
              hourly_salary: attributeSchema("Hourly rate in euros; 0 for salaried staff.", { type: "number" }),
              last_modified_at: attributeSchema("When the record last changed.", { type: "string" }),
            },
            additionalProperties: { $ref: "#/components/schemas/Attribute" },
          },
        },
      },
      TimeOffType: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["TimeOffType"] },
          attributes: {
            type: "object",
            properties: { id: { type: "integer" }, name: { type: "string" }, category: { type: "string" } },
          },
        },
      },
      TimeOffPeriod: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["TimeOffPeriod"] },
          attributes: {
            type: "object",
            properties: {
              id: { type: "integer" },
              status: { type: "string", enum: ["approved", "pending", "rejected"] },
              start_date: { type: "string" },
              end_date: { type: "string" },
              days_count: { type: "number" },
              half_day_start: { type: "integer" },
              half_day_end: { type: "integer" },
              time_off_type: { $ref: "#/components/schemas/TimeOffType" },
              employee: { $ref: "#/components/schemas/Employee" },
              created_at: { type: "string" },
            },
          },
        },
      },
      Error: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          error: { type: "object", properties: { code: { type: "integer" }, message: { type: "string" } } },
        },
      },
    },
  },
};

const docs = (request: BenchRequest): BenchResponse => {
  const path = request.url.pathname.replace(/\/+$/, "");
  if (path === "" || path === "/docs" || path === "/docs/api") return html(DOCS_PAGE);
  if (path === "/docs/openapi.json") return json(OPENAPI);
  return notFound();
};

export const staffnest: MockProvider = {
  id: "staffnest",
  split: "heldout",
  pattern:
    "HR (Personio-style): every field a {label, value} envelope, department two objects deep, custom fields keyed dynamic_<id>; " +
    "the docs call `offset` records to skip, but it is a 0-based page number, so a second page at a record offset comes back empty.",
  hosts: [API, DEV],
  docsUrl: `https://${DEV}/docs/api`,
  credentials: [SERVICE_USER, TOKEN],
  credentialLabels: ["Service user ID", "Token"],
  objectives: [
    {
      id: "active-engineers",
      request: "How many active employees do we have in Engineering?",
      answer: ACTIVE_ENGINEERS,
      tolerance: 0,
      records: EMPLOYEES.length,
      scripted: {
        path: "/company/employees",
        measure: {
          agg: "count",
          where:
            'attributes.status.value == "active" && attributes.department.value.attributes.name == "Engineering"',
        },
      },
    },
    {
      id: "active-platform-team",
      request: "How many active employees are on the Platform team?",
      answer: ACTIVE_PLATFORM_TEAM,
      tolerance: 0,
      records: EMPLOYEES.length,
      scripted: {
        path: "/company/employees",
        measure: {
          agg: "count",
          where: 'attributes.status.value == "active" && attributes.dynamic_24810.value == "Platform"',
        },
      },
    },
  ],
  handle(request) {
    if (request.url.hostname === API) return api(request);
    if (request.url.hostname === DEV) return docs(request);
    return notFound();
  },
  reference: {
    connection: {
      specVersion: 1,
      id: "staffnest",
      title: "Staffnest",
      kind: "rest",
      baseUrl: `https://${API}/v1`,
      auth: {
        type: "basic",
        usernameRef: "staffnest-service-user",
        keyRef: "staffnest-token",
        usernameLabel: "Service user ID",
        label: "Token",
      },
      dialect: {
        auth: {
          type: "basic",
          usernameRef: "staffnest-service-user",
          keyRef: "staffnest-token",
          usernameLabel: "Service user ID",
          label: "Token",
        },
        /* What trying it shows: `offset` counts pages from 0, not records. */
        pagination: { kind: "page", param: "offset", startsAt: 0, limitParam: "limit", pageSize: 100 },
        headers: {},
        query: {},
      },
      ops: [
        {
          id: "employees",
          title: "Employees",
          method: "GET",
          path: "/company/employees",
          archetype: "list",
          params: [],
          query: {},
          headers: {},
          rowsPath: "$.data",
        },
      ],
    },
    secrets: { "staffnest-service-user": SERVICE_USER, "staffnest-token": TOKEN },
  },
};
