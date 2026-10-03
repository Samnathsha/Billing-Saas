import { formatPaise } from "@/lib/money";

// A supplier balance in words: positive = we owe them.
export const balanceText = (paise: number): string =>
  paise === 0 ? "Settled" : paise > 0 ? `We owe ${formatPaise(paise)}` : `Advance ${formatPaise(-paise)}`;
