// Replays the stock ledger from scratch and compares the result with the
// stored balances (blueprint Phase 6). Integer fixed-point arithmetic
// (BigInt) only: quantities in thousandths, costs in ten-thousandths of a
// paisa, mirroring the SQL in src/modules/inventory/repo.ts:
// - stock in (and any VOID_REVERSAL): average = round((q*avg + d*cost) /
//   (q + d), 4), never below 0; 0 when nothing is left;
// - stock out: quantity goes down, average unchanged;
// - quantity never below zero.

export interface ReplayMovement {
  variantId: string;
  branchId: string;
  movementType: string;
  quantity: string; // "-2.000"
  unitCostPaise: string; // "1333.3333"
  seq: number;
}

export interface StoredBalance {
  variantId: string;
  branchId: string;
  quantity: string;
  averageCostPaise: string;
}

export interface StockDifference {
  variantId: string;
  branchId: string;
  problem: "quantity" | "average_cost" | "no_balance_row" | "went_below_zero";
  expected: string;
  found: string;
}

const ADDS_AT_COST = new Set(["PURCHASE_IN", "OPENING_STOCK", "SALE_RETURN_IN", "TRANSFER_IN", "ADJUSTMENT_IN", "VOID_REVERSAL"]);
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

// "12.5", 3 -> 12500n. More decimals than `scale` is an error (never rounds).
export function toScaled(text: string, scale: number): bigint {
  const match = DECIMAL.exec(text);
  if (match === null) throw new Error(`not a decimal number: ${text}`);
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  if (fraction.length > scale) throw new Error(`more than ${String(scale)} decimals: ${text}`);
  const value = BigInt(match[2] ?? "0") * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0");
  return match[1] === "-" ? -value : value;
}

export function fromScaled(value: bigint, scale: number): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const unit = 10n ** BigInt(scale);
  return `${sign}${String(abs / unit)}.${String(abs % unit).padStart(scale, "0")}`;
}

// a / b rounded half away from zero (PostgreSQL's round() on numeric), b > 0.
const divRound = (a: bigint, b: bigint): bigint => (a >= 0n ? (2n * a + b) / (2n * b) : -((2n * -a + b) / (2n * b)));

export interface Running {
  quantity: bigint; // thousandths
  average: bigint; // ten-thousandths of a paisa
  wentBelowZero: boolean;
}

// Movements must come in `seq` order (the order they were applied).
export function replay(movements: Iterable<ReplayMovement>, into = new Map<string, Running>()): Map<string, Running> {
  for (const m of movements) {
    const key = `${m.variantId}|${m.branchId}`;
    const state = into.get(key) ?? { quantity: 0n, average: 0n, wentBelowZero: false };
    const d = toScaled(m.quantity, 3);
    const next = state.quantity + d;
    if (next < 0n) state.wentBelowZero = true;
    if (ADDS_AT_COST.has(m.movementType)) {
      if (next > 0n) {
        const average = divRound(state.quantity * state.average + d * toScaled(m.unitCostPaise, 4), next);
        state.average = average > 0n ? average : 0n;
      } else {
        state.average = 0n;
      }
    }
    state.quantity = next;
    into.set(key, state);
  }
  return into;
}

export function compare(expected: Map<string, Running>, stored: StoredBalance[]): StockDifference[] {
  const differences: StockDifference[] = [];
  const byKey = new Map(stored.map((b) => [`${b.variantId}|${b.branchId}`, b]));
  for (const [key, state] of expected) {
    const [variantId = "", branchId = ""] = key.split("|");
    const where = { variantId, branchId };
    if (state.wentBelowZero) differences.push({ ...where, problem: "went_below_zero", expected: "never below 0", found: "below 0 at some point" });
    const row = byKey.get(key);
    byKey.delete(key);
    if (row === undefined) {
      differences.push({ ...where, problem: "no_balance_row", expected: fromScaled(state.quantity, 3), found: "missing" });
      continue;
    }
    if (toScaled(row.quantity, 3) !== state.quantity) {
      differences.push({ ...where, problem: "quantity", expected: fromScaled(state.quantity, 3), found: row.quantity });
    }
    if (toScaled(row.averageCostPaise, 4) !== state.average) {
      differences.push({ ...where, problem: "average_cost", expected: fromScaled(state.average, 4), found: row.averageCostPaise });
    }
  }
  // Balance rows with no movements at all must be empty.
  for (const row of byKey.values()) {
    if (toScaled(row.quantity, 3) !== 0n) differences.push({ variantId: row.variantId, branchId: row.branchId, problem: "quantity", expected: "0.000", found: row.quantity });
    if (toScaled(row.averageCostPaise, 4) !== 0n) {
      differences.push({ variantId: row.variantId, branchId: row.branchId, problem: "average_cost", expected: "0.0000", found: row.averageCostPaise });
    }
  }
  return differences;
}
