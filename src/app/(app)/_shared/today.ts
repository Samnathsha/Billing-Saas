import "server-only";

// Today as YYYY-MM-DD in India (rule 1.5), for date fields' default and
// maximum. The services check dates again in the business's own time zone.
export const todayInIndia = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
