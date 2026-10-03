# Billing and the till (Phase 7)

Business rules: `docs/business-rules.md` sections 3–8, 12 and 15, and open
questions 2, 5–8, 17, 18 and 36–40 (accountant and owner to confirm).

## Screens

| Screen | Who | What |
| --- | --- | --- |
| New bill (`/pos`) | "Create sale" | The till: scan or type a SKU/barcode, or search by name; quantities, discounts, customer, cash/UPI/card, credit; hold and resume |
| Bills (`/sales`) | sales, reports, managers | The bills of a day, with the day's total (voided bills not counted) |
| Bill (`/sales/<id>`) | same | The printable bill; void (Manager and above, same day only) |

Keys at the till: **F2** jumps to the scan box, **F9** saves the bill. A USB
barcode scanner types the code and presses Enter, which adds the item.

## How a sale works

`createSale` (`src/modules/sales/service.ts`) is ONE database transaction,
following blueprint 7.5:

1. The idempotency key: a double click or a retry returns the bill already
   saved; the bill's id is made on the device.
2. Settings, items, prices and GST rates come from the database. The
   browser sends item ids, quantities, discounts and payments only; a price
   from the browser is refused.
3. The cashier's discount limit (5% by default) is checked on the whole
   bill and on each line.
4. The total is computed with `src/lib/bill-maths.ts` (integer paise, the
   same code as the till's preview). If it differs from what the till
   showed, the sale is refused instead of charging a surprise.
5. Credit: a customer is needed, and their balance after the sale must stay
   within their limit (checked under a lock, so two tills cannot both use
   the last credit).
6. The bill number is taken with a row lock; a failed sale gives it back.
7. The bill (with a copy of seller, buyer, item, price, rate and cost
   details), its lines and payments are saved; stock goes out through
   `postMovements` (never below zero); IMEIs are marked sold with their
   warranty end date; the customer's account gets the credit; audit entry.

A **void** (same day, Manager and above, with a reason) adds reversing rows:
stock back in at the original cost, refund rows for the money, the credit
taken off the customer's account. The bill's own rows never change; the
database refuses any other change to a posted bill.

## GST on the bill

- Registered (regular) business: **Tax Invoice** with CGST + SGST (same
  state) or IGST (a registered buyer in another state, from their GSTIN).
- Composition or unregistered business: **Bill of Supply**, no GST.
- Rates come from `tax_rates` by date (and price per piece for slabs).
  Until the accountant supplies real rates, only **TEST 5%** and
  **TEST 18%** exist, and they print as "TEST" on the bill.

## Tests

- `src/lib/bill-maths.test.ts` (63 hand-checked cases) and
  `bill-maths.property.test.ts` (8 rules on 3,000 random bills each)
- `tests/integration/sales.test.ts`, `invoice-sequences.test.ts`,
  `customers.test.ts`; the two-tills and double-click tests passed 10 runs
  in a row
- `tests/flows/pos.spec.ts` (the till and the printed bill in a browser)
- Isolation suites cover customers, invoice_sequences, invoices,
  invoice_items and invoice_payments.

## Not built yet

Customer payments against their balance, returns and credit notes (Phase 8);
reports (Phase 9); a PDF file of the bill (the browser's "Print" can save as
PDF); e-invoicing (open question 19).

## Phase 7 sign-off (2026-10-03)

The owner tested by hand on the dev database: the till (scan a SKU, change
the quantity, cash with change), the printed Tax Invoice, printing, stock
going down, the day's bills; a bill with a line discount and a UPI + cash
split; a customer with a ₹1,000 credit limit buying partly on credit and
the balance on the customer's page; a same-day void (refund shown, the
customer's balance and the stock restored). The owner then signed off
Phase 7.

Covered by automated browser tests instead (`tests/flows/pos.spec.ts`): a
cashier's discount above 5% blocked, a cashier cannot void, a credit sale
over the limit refused.

**Before going live (blueprint "done when"):** about 50 varied test sales by
the owner, and the accountant checks 5 printed bills against a calculator,
together with the real GST rates (open questions 1–2) and questions 36–40.
