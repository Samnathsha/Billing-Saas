// How much of a bill line a return gives back (open question 9: at the
// bill's own rates). Pure and exact (BigInt). Each part (taxable value,
// CGST, IGST) is the line's amount for everything returned so far, minus
// what earlier returns already took, each rounded half up. So partial
// returns never add up to more than the line, and returning everything
// gives back exactly the line: never a paisa more or less.

export interface LineAmounts {
  taxablePaise: number;
  cgstPaise: number; // = SGST
  igstPaise: number;
}

export interface ReturnAmounts extends LineAmounts {
  sgstPaise: number;
  totalPaise: number;
}

// a * num / den rounded half up, all >= 0, den > 0.
const scaled = (a: bigint, num: bigint, den: bigint): bigint => (2n * a * num + den) / (2n * den);

export function returnAmounts(line: LineAmounts, soldMilli: bigint, alreadyMilli: bigint, nowMilli: bigint): ReturnAmounts {
  if (soldMilli <= 0n || alreadyMilli < 0n || nowMilli <= 0n) throw new Error("returnAmounts: bad quantities");
  if (alreadyMilli + nowMilli > soldMilli) throw new Error("returnAmounts: more than was sold");
  const part = (amount: number): number => {
    const a = BigInt(amount);
    return Number(scaled(a, alreadyMilli + nowMilli, soldMilli) - scaled(a, alreadyMilli, soldMilli));
  };
  const taxable = part(line.taxablePaise);
  const cgst = part(line.cgstPaise);
  const igst = part(line.igstPaise);
  return { taxablePaise: taxable, cgstPaise: cgst, sgstPaise: cgst, igstPaise: igst, totalPaise: taxable + 2 * cgst + igst };
}
