// Liveness check for uptime monitors and the hosting platform. It answers
// only "the server is running": no version, database or system details,
// which would help an attacker. Other methods get 405 from Next.js.
export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
