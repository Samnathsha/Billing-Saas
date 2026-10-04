import type { ErrorEvent, init } from "@sentry/nextjs";

// What leaves the app when an error is reported (Phase 11; blueprint 13.3:
// "Sentry for errors with personal data scrubbed"). Kept: the error's type,
// its stack (code locations), the page or route without its query, the
// browser. Removed: cookies, headers (except the browser name), request
// bodies and query strings, the user, extra data, and in every text:
// email addresses, long numbers (phones, IMEIs, accounts), GSTINs, tokens
// and connection strings.

const PATTERNS: [RegExp, string][] = [
  [/postgres(ql)?:\/\/\S+/gi, "[connection]"],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]"],
  [/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, "[gstin]"],
  [/\b[A-Za-z0-9_-]{32,}\b/g, "[token]"],
  [/\+?\d[\d -]{5,}\d/g, "[number]"],
];

export function scrubText(text: string): string {
  return PATTERNS.reduce((t, [pattern, replacement]) => t.replace(pattern, replacement), text);
}

const withoutQuery = (url: string): string => url.split(/[?#]/)[0] ?? "";

// Sentry's own collection, before scrubEvent: nothing about the person,
// no cookies, bodies or query values; of the headers only the browser name.
export const SENTRY_DATA_COLLECTION: NonNullable<Parameters<typeof init>[0]>["dataCollection"] = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: { allow: ["user-agent"] }, response: false },
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
};

const crumbData = (data: Record<string, unknown> | undefined): Record<string, string | number> | undefined => {
  if (typeof data?.url !== "string") return undefined;
  const out: Record<string, string | number> = { url: withoutQuery(data.url) };
  if (typeof data.method === "string") out.method = data.method;
  if (typeof data.status_code === "number") out.status_code = data.status_code;
  return out;
};

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const userAgent = event.request?.headers?.["user-agent"];
  return {
    ...event,
    user: undefined,
    extra: undefined,
    request:
      event.request === undefined
        ? undefined
        : {
            method: event.request.method,
            url: event.request.url === undefined ? undefined : withoutQuery(event.request.url),
            headers: userAgent === undefined ? {} : { "user-agent": userAgent },
          },
    message: event.message === undefined ? undefined : scrubText(event.message),
    exception:
      event.exception === undefined
        ? undefined
        : { ...event.exception, values: event.exception.values?.map((v) => ({ ...v, value: v.value === undefined ? undefined : scrubText(v.value) })) },
    breadcrumbs: event.breadcrumbs?.map((b) => ({
      ...b,
      message: b.message === undefined ? undefined : scrubText(b.message),
      data: crumbData(b.data),
    })),
  };
}
