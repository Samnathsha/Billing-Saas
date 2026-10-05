// Light load test (Phase 11; docs/load-test.md). Run against a LOCAL
// production build with the data from `npm run load:fixture`:
//   k6 run -e BASE=http://localhost:3500 -e SCENARIO=login  tests/load/k6.js
//   (SCENARIO = login | search | sales)
import exec from "k6/execution";
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE || "http://localhost:3500";
const SCENARIO = __ENV.SCENARIO || "login";
const fixture = JSON.parse(open(__ENV.FIXTURE || "../../.load/fixture.json"));

const SCENARIOS = {
  login: { executor: "shared-iterations", vus: 10, iterations: 50, maxDuration: "2m" },
  search: { executor: "constant-vus", vus: 20, duration: "60s" },
  sales: { executor: "per-vu-iterations", vus: fixture.tills.length, iterations: fixture.tills[0].ops.length, maxDuration: "5m" },
};

export const options = {
  scenarios: { [SCENARIO]: SCENARIOS[SCENARIO] },
  thresholds: {
    checks: ["rate==1"],
    http_req_failed: ["rate==0"],
    "http_req_duration{kind:login}": ["p(95)<2000"],
    "http_req_duration{kind:search}": ["p(95)<1000"],
    "http_req_duration{kind:sale}": ["p(95)<1000"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "max"],
};

// Each login comes from its own address, as different shops would (the
// per-address login limit is not what is measured here).
const ip = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${(n & 255) || 1}`;

function logIn(n) {
  return http.post(`${BASE}/api/auth/sign-in/email`, JSON.stringify({ email: fixture.email, password: fixture.password }), {
    headers: { "Content-Type": "application/json", Origin: BASE, "X-Forwarded-For": ip(n) },
    tags: { kind: "login" },
  });
}

export function setup() {
  if (SCENARIO === "login") return {};
  const res = logIn(99999);
  const cookie = Object.entries(res.cookies).map(([name, values]) => `${name}=${values[0].value}`).join("; ");
  return { cookie };
}

export default function (data) {
  if (SCENARIO === "login") {
    const res = logIn(exec.scenario.iterationInTest + 1);
    check(res, { "login 200": (r) => r.status === 200 });
    return;
  }
  if (SCENARIO === "search") {
    const res = http.get(`${BASE}/catalog/products?q=${encodeURIComponent(fixture.search)}`, { headers: { Cookie: data.cookie }, tags: { kind: "search" }, redirects: 0 });
    check(res, { "search 200": (r) => r.status === 200 && r.body.includes(fixture.search) });
    return;
  }
  const till = fixture.tills[exec.vu.idInTest - 1];
  const op = till.ops[exec.vu.iterationInScenario];
  const res = http.post(`${BASE}/api/sync/operations`, JSON.stringify(op), {
    headers: { "Content-Type": "application/json", Origin: BASE, Cookie: data.cookie, "x-till-token": till.token },
    tags: { kind: "sale" },
  });
  check(res, { "sale saved": (r) => r.status === 200 && JSON.parse(r.body).number === op.number });
}
