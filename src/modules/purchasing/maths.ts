// Purchase line maths (business rules 14). Integer arithmetic only (BigInt),
// never floating point. Rounding: half up, per line, to the paisa (an OPEN
// QUESTION for the accountant; see docs/business-rules.md).

const QTY = /^(\d{1,11})(?:\.(\d{1,3}))?$/;
const RATE = /^(\d{1,3})(?:\.(\d{1,4}))?$/;

// "2.5" -> 2500n (thousandths of a unit).
export function quantityToMilli(quantity: string): bigint {
  const match = QTY.exec(quantity);
  if (match === null) throw new Error("quantityToMilli: bad quantity");
  return BigInt(match[1] ?? "0") * 1000n + BigInt((match[2] ?? "").padEnd(3, "0"));
}

// "18" -> 180000n, "0.25" -> 2500n (ten-thousandths of a percent).
export function rateToE4(rate: string): bigint {
  const match = RATE.exec(rate);
  if (match === null) throw new Error("rateToE4: bad rate");
  const value = BigInt(match[1] ?? "0") * 10000n + BigInt((match[2] ?? "").padEnd(4, "0"));
  if (value > 1_000_000n) throw new Error("rateToE4: above 100%");
  return value;
}

// a / b rounded half up, for a >= 0 and b > 0.
const divRound = (a: bigint, b: bigint): bigint => (2n * a + b) / (2n * b);

// 12345678n -> "1234.5678"
const e4ToText = (value: bigint): string => `${String(value / 10000n)}.${String(value % 10000n).padStart(4, "0")}`;

export interface LineAmounts {
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  // Cost per unit going into stock, 4 decimals of a paisa.
  unitCostPaise: string;
}

export function purchaseLineAmounts(input: {
  quantity: string;
  unitPricePaise: number;
  taxRate: string;
  costBasis: "excludes_tax" | "includes_tax";
}): LineAmounts {
  if (!Number.isSafeInteger(input.unitPricePaise) || input.unitPricePaise < 0) throw new Error("purchaseLineAmounts: bad price");
  const milli = quantityToMilli(input.quantity);
  if (milli === 0n) throw new Error("purchaseLineAmounts: zero quantity");
  const subtotal = divRound(milli * BigInt(input.unitPricePaise), 1000n);
  const tax = divRound(subtotal * rateToE4(input.taxRate), 1_000_000n);
  const total = subtotal + tax;
  const base = input.costBasis === "excludes_tax" ? subtotal : total;
  return {
    subtotalPaise: Number(subtotal),
    taxPaise: Number(tax),
    totalPaise: Number(total),
    unitCostPaise: e4ToText(divRound(base * 10000n * 1000n, milli)),
  };
}
