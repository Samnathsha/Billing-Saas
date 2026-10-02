// GST basics for India (business rules 1.1, 4.5). Pure functions, no
// database. Owner or accountant to validate: the state list below and the
// GSTIN rules (open question 26 in docs/business-rules.md).

// GST state codes (the first two digits of a GSTIN). Owner or accountant to
// validate: 26 is Dadra and Nagar Haveli and Daman and Diu (merged in 2020;
// the old 25 is not offered); 37 is Andhra Pradesh (28 was its code before
// 2014 and is not offered); 97 is "Other Territory". 99 (Centre
// Jurisdiction) is not a place for a shop and is not offered.
export const GST_STATES: ReadonlyMap<string, string> = new Map([
  ["01", "Jammu and Kashmir"],
  ["02", "Himachal Pradesh"],
  ["03", "Punjab"],
  ["04", "Chandigarh"],
  ["05", "Uttarakhand"],
  ["06", "Haryana"],
  ["07", "Delhi"],
  ["08", "Rajasthan"],
  ["09", "Uttar Pradesh"],
  ["10", "Bihar"],
  ["11", "Sikkim"],
  ["12", "Arunachal Pradesh"],
  ["13", "Nagaland"],
  ["14", "Manipur"],
  ["15", "Mizoram"],
  ["16", "Tripura"],
  ["17", "Meghalaya"],
  ["18", "Assam"],
  ["19", "West Bengal"],
  ["20", "Jharkhand"],
  ["21", "Odisha"],
  ["22", "Chhattisgarh"],
  ["23", "Madhya Pradesh"],
  ["24", "Gujarat"],
  ["26", "Dadra and Nagar Haveli and Daman and Diu"],
  ["27", "Maharashtra"],
  ["29", "Karnataka"],
  ["30", "Goa"],
  ["31", "Lakshadweep"],
  ["32", "Kerala"],
  ["33", "Tamil Nadu"],
  ["34", "Puducherry"],
  ["35", "Andaman and Nicobar Islands"],
  ["36", "Telangana"],
  ["37", "Andhra Pradesh"],
  ["38", "Ladakh"],
  ["97", "Other Territory"],
]);

export const isGstStateCode = (code: string): boolean => GST_STATES.has(code);

// 2-digit state, 10-character PAN (5 letters, 4 digits, 1 letter), entity
// number (1-9 or A-Z), the letter Z, and a check character.
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// The 15th character: a base-36 check over the first 14 (weights 1 and 2,
// alternating; each product's base-36 digits are added).
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHARS.indexOf(first14.charAt(i));
    if (value < 0) throw new Error("gstinCheckChar: invalid character");
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS.charAt((36 - (sum % 36)) % 36);
}

export type GstinProblem = "FORMAT" | "CHECK_CHARACTER" | "UNKNOWN_STATE";

// Checks shape, check character and state code. Expects upper case without
// spaces (normaliseGstin first). Cannot tell whether the GSTIN is actually
// registered; that needs the GST portal.
export function gstinProblem(gstin: string): GstinProblem | null {
  if (!GSTIN_PATTERN.test(gstin)) return "FORMAT";
  if (!isGstStateCode(gstin.slice(0, 2))) return "UNKNOWN_STATE";
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin.charAt(14)) return "CHECK_CHARACTER";
  return null;
}

export const normaliseGstin = (raw: string): string => raw.replace(/\s+/g, "").toUpperCase();

// How the business is registered for GST (rule 4.5). Owner or accountant to
// validate which applies; it decides what the bill shows (open questions 14,
// 15).
export const GST_REGISTRATIONS = ["registered", "composition", "unregistered"] as const;
export type GstRegistration = (typeof GST_REGISTRATIONS)[number];

// Registered and composition businesses have a GSTIN; unregistered ones do not.
export const needsGstin = (registration: GstRegistration): boolean => registration !== "unregistered";
