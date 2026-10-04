import * as Sentry from "@sentry/nextjs";
import { scrubEvent, SENTRY_DATA_COLLECTION } from "@/lib/error-scrub";

// Browser error reports (Phase 11). Off unless NEXT_PUBLIC_SENTRY_DSN is set
// at build time (a DSN is an address, not a secret). Reports go to this
// site's /monitoring route (next.config.ts), so the Content Security Policy
// stays 'self'. No session replay, no tracing, personal data scrubbed.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: dsn !== undefined && dsn !== "",
  dataCollection: SENTRY_DATA_COLLECTION,
  tracesSampleRate: 0,
  beforeSend: scrubEvent,
  beforeSendTransaction: () => null,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
