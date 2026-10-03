// Bill maths (business rules 3, 4.4, 8 and section 15). Pure and exact:
// integer paise, BigInt inside, never floating point. The same function runs
// in the browser (cart preview) and on the server (the authority, rule 3.6).
//
// Per line, in this order:
// 1. gross     = quantity x unit price, rounded half up to the paisa
// 2. discount  = the line's own discount, then its share of a bill discount
// 3. amount    = gross - discounts (GST is on the price after discount, Q6)
// 4. GST:
//    - not charged (composition / unregistered: bill of supply): tax 0
//    - tax-exclusive prices: GST added on top of amount
//    - tax-inclusive prices: GST taken out of amount; the line total stays
//      exactly the price paid (rule 3.3)
//    - same state: CGST = SGST, each computed on the taxable value at half
//      the rate (always equal halves; OPEN QUESTION 36)
//    - other state: IGST
// Bill: the sum of the lines, then an optional round-off to the nearest
// rupee (50 paise and above round up; Q5).

const QTY = /^(\d{1,11})(?:\.(\d{1,3}))?$/;
const RATE = /^(\d{1,3})(?:\.(\d{1,4}))?$/;
const MAX_PAISE = 100_000_000_000; // ₹100 crore per bill
const RATE_ONE = 1_000_000n; // 100% in ten-thousandths of a percent

export class BillMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillMathError";
  }
}

export interface BillLineInput {
  quantity: string; // "2", "1.5" (at most 3 decimals)
  unitPricePaise: number; // the product's price, as the business sets prices
  taxRate: string; // GST %, e.g. "5", "18", "0.25"
  discountPaise: number; // this line's own discount, in paise
}

export interface BillInput {
  lines: BillLineInput[];
  pricesIncludeTax: boolean;
  chargesGst: boolean; // false: composition or unregistered (bill of supply)
  interState: boolean; // the buyer is in another state: IGST
  billDiscountPaise: number; // a discount on the whole bill, in paise
  roundOff: boolean;
}

export interface BillLineResult {
  grossPaise: number;
  lineDiscountPaise: number;
  billDiscountPaise: number; // this line's share of the bill discount
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
}

export interface BillResult {
  lines: BillLineResult[];
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number; // before round-off
  roundOffPaise: number; // -49 ... +50
  payablePaise: number;
}

export function quantityToMilli(quantity: string): bigint {
  const match = QTY.exec(quantity);
  if (match === null) throw new BillMathError("Enter a quantity with at most 3 decimals.");
  return BigInt(match[1] ?? "0") * 1000n + BigInt((match[2] ?? "").padEnd(3, "0"));
}

export function rateToE4(rate: string): bigint {
  const match = RATE.exec(rate);
  if (match === null) throw new BillMathError("Enter a GST rate, e.g. 5 or 18.");
  const value = BigInt(match[1] ?? "0") * 10_000n + BigInt((match[2] ?? "").padEnd(4, "0"));
  if (value > RATE_ONE) throw new BillMathError("A GST rate cannot be above 100%.");
  return value;
}

// a / b rounded half up, for a >= 0 and b > 0.
const divRound = (a: bigint, b: bigint): bigint => (2n * a + b) / (2n * b);

const paise = (value: number, what: string): bigint => {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PAISE) throw new BillMathError(`${what}: enter a whole number of paise.`);
  return BigInt(value);
};

// Splits `total` paise over lines in proportion to `weights`, exactly:
// every line gets its share rounded down, then the paise left over go one at
// a time to the lines with the largest leftover fractions (ties: the larger
// line, then the earlier line). No share is ever below 0 or above its weight.
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n) return weights.map(() => 0n);
  if (total < 0n || total > sum) throw new BillMathError("The bill discount cannot be more than the bill.");
  const shares = weights.map((w) => (total * w) / sum);
  let left = total - shares.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, w, remainder: (total * w) % sum }))
    .sort((a, b) => (a.remainder !== b.remainder ? (b.remainder > a.remainder ? 1 : -1) : a.w !== b.w ? (b.w > a.w ? 1 : -1) : a.i - b.i));
  for (const { i } of order) {
    if (left === 0n) break;
    shares[i] = (shares[i] ?? 0n) + 1n;
    left -= 1n;
  }
  return shares;
}

export function computeBill(input: BillInput): BillResult {
  if (input.lines.length === 0) throw new BillMathError("Add at least one item.");
  if (input.lines.length > 500) throw new BillMathError("A bill can have at most 500 lines.");

  const prepared = input.lines.map((line, index) => {
    const milli = quantityToMilli(line.quantity);
    if (milli === 0n) throw new BillMathError(`Line ${String(index + 1)}: enter a quantity above zero.`);
    const gross = divRound(milli * paise(line.unitPricePaise, "Price"), 1000n);
    const lineDiscount = paise(line.discountPaise, "Discount");
    if (lineDiscount > gross) throw new BillMathError(`Line ${String(index + 1)}: the discount is more than the line.`);
    return { gross, lineDiscount, rate: input.chargesGst ? rateToE4(line.taxRate) : 0n };
  });
  const shares = allocate(
    paise(input.billDiscountPaise, "Bill discount"),
    prepared.map((p) => p.gross - p.lineDiscount),
  );

  const lines = prepared.map((p, i): BillLineResult => {
    const share = shares[i] ?? 0n;
    const amount = p.gross - p.lineDiscount - share;
    let taxable = amount;
    let cgst = 0n;
    let igst = 0n;
    if (p.rate > 0n) {
      if (input.pricesIncludeTax) {
        const net = divRound(amount * RATE_ONE, RATE_ONE + p.rate);
        if (input.interState) {
          taxable = net;
          igst = amount - net;
        } else {
          cgst = divRound(net * p.rate, 2n * RATE_ONE);
          taxable = amount - 2n * cgst;
        }
      } else if (input.interState) {
        igst = divRound(amount * p.rate, RATE_ONE);
      } else {
        cgst = divRound(amount * p.rate, 2n * RATE_ONE);
      }
    }
    const tax = 2n * cgst + igst;
    return {
      grossPaise: Number(p.gross),
      lineDiscountPaise: Number(p.lineDiscount),
      billDiscountPaise: Number(share),
      taxablePaise: Number(taxable),
      cgstPaise: Number(cgst),
      sgstPaise: Number(cgst),
      igstPaise: Number(igst),
      taxPaise: Number(tax),
      totalPaise: Number(taxable + tax),
    };
  });

  const sum = (pick: (l: BillLineResult) => number): number => lines.reduce((s, l) => s + pick(l), 0);
  const total = sum((l) => l.totalPaise);
  if (total > MAX_PAISE) throw new BillMathError("This bill total is too large.");
  const roundOff = input.roundOff ? Number(divRound(BigInt(total), 100n) * 100n) - total : 0;
  return {
    lines,
    grossPaise: sum((l) => l.grossPaise),
    discountPaise: sum((l) => l.lineDiscountPaise + l.billDiscountPaise),
    taxablePaise: sum((l) => l.taxablePaise),
    cgstPaise: sum((l) => l.cgstPaise),
    sgstPaise: sum((l) => l.sgstPaise),
    igstPaise: sum((l) => l.igstPaise),
    taxPaise: sum((l) => l.taxPaise),
    totalPaise: total,
    roundOffPaise: roundOff,
    payablePaise: total + roundOff,
  };
}

// Rule 8: the whole bill's discount, and each line's own discount, must stay
// within the limit (basis points: 500 = 5%). null = no limit.
export function discountWithinLimit(bill: BillResult, limitBps: number | null): boolean {
  if (limitBps === null) return true;
  const limit = BigInt(limitBps);
  const within = (discount: number, gross: number): boolean => BigInt(discount) * 10_000n <= BigInt(gross) * limit;
  return within(bill.discountPaise, bill.grossPaise) && bill.lines.every((l) => within(l.lineDiscountPaise, l.grossPaise));
}
