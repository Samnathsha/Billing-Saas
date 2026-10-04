// Which backup copies to delete (blueprint 13.2: keep 30 daily and 12
// monthly copies). Pure, so it is tested. Keys look like
// "daily/2026-10-04.dump.age" and "monthly/2026-10.dump.age"; anything else
// in the bucket is never touched.

const DAILY = /^daily\/(\d{4})-(\d{2})-(\d{2})\.dump\.age$/;
const MONTHLY = /^monthly\/(\d{4})-(\d{2})\.dump\.age$/;

export const KEEP_DAILY = 30;
export const KEEP_MONTHLY = 12;

// today: "YYYY-MM-DD" (the day of this backup).
export function backupsToDelete(keys: readonly string[], today: string): string[] {
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(todayMs)) throw new Error("backupsToDelete: bad day");
  const [year = 0, month = 0] = today.split("-").map(Number);
  const thisMonth = year * 12 + (month - 1);
  return keys.filter((key) => {
    const daily = DAILY.exec(key);
    if (daily !== null) {
      const age = (todayMs - Date.parse(`${daily[1] ?? ""}-${daily[2] ?? ""}-${daily[3] ?? ""}T00:00:00Z`)) / 86_400_000;
      return age >= KEEP_DAILY;
    }
    const monthly = MONTHLY.exec(key);
    if (monthly !== null) return thisMonth - (Number(monthly[1]) * 12 + Number(monthly[2]) - 1) >= KEEP_MONTHLY;
    return false;
  });
}
