import * as Sentry from "@sentry/nextjs";
import { scrubEvent, SENTRY_DATA_COLLECTION } from "@/lib/error-scrub";

// Server error reports (Phase 11; blueprint 13.3). Off unless SENTRY_DSN is
// set. No personal data: Sentry's own collection of it is off, and every
// event goes through scrubEvent. No performance tracing.
const dsn = process.env.SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: dsn !== undefined && dsn !== "",
  environment: process.env.NODE_ENV,
  dataCollection: SENTRY_DATA_COLLECTION,
  tracesSampleRate: 0,
  beforeSend: scrubEvent,
  beforeSendTransaction: () => null,
});
