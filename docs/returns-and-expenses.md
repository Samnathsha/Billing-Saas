# Returns, exchanges, payments and expenses (Phase 8)

Business rules: `docs/business-rules.md` section 16 and open questions
9–10, 41–43 (accountant and owner to confirm).

## Screens

| Screen | Who | What |
| --- | --- | --- |
| Customer (`/customers/<id>`) | "Create sale" to take payments | Take a payment (cash/UPI/card); payments list; bills |
| Return items (bill → **Return items**) | "Create sale"; past 7 days Manager and above | What comes back, sell again or damaged, money back or store credit |
| Credit note (`/credit-notes/<id>`) | sales, reports, managers | The printable credit note (`CN/26-27/00001`) |
| Exchange (bill → **Exchange**) | same as returns | Items back and new items out in one save; pay or get back the difference |
| Return to supplier (purchase → **Return goods to the supplier**) | "Create purchase" | Goods back; what we owe goes down |
| Expenses (`/expenses`) | "Record expenses" (Owner, Admin, Manager); Accountant views | Categories, record, void, totals for a date range |

## How it works

- **Every one of these is one database transaction** with an idempotency key
  (a double click saves once) and an audit entry. If anything fails, nothing
  is saved, and no bill or credit note number is used up.
- **Returns** never take back more than was sold (earlier returns count); two
  tills returning against the same bill queue for it. Amounts reverse the
  bill's own lines at their own GST rates (`src/lib/return-maths.ts`), so
  partial returns add up exactly to the bill. Resellable items go back into
  stock at the bill's cost; damaged ones stay out. A bill with a return can
  no longer be voided.
- **Exchanges** are a return and a sale together: the returned value pays the
  new bill first ("Exchange" on the bill, naming the credit note). A bill
  paid by an exchange cannot be voided.
- **Customer payments and store credit** are rows in the customer's
  append-only account; the balance is always their sum.
- **Returns to suppliers** reverse the purchase line exactly and lower what
  we owe; the goods leave stock at the average cost (question 42).
- **Expenses** are never edited: a mistake is voided with a reason and
  entered again. New permission "Record expenses".
- `npm run stock:rebuild` still finds no difference after all of these
  (tested).

## Hand test: 20 scenarios (blueprint "done when")

Each must leave stock, the customer's or supplier's balance and the bill
totals exactly as written. Use one test item at ₹799 (TEST 5%) unless said.

1. Sell 2; return 1 for cash → credit note ₹799.00, stock +1.
2. Return the other 1 for cash → the two credit notes add up to the bill.
3. Try to return a 3rd → refused ("more than was sold").
4. Sell 1; return it as damaged → refund ₹799.00, stock unchanged.
5. Customer with ₹2,000 credit buys 1 on credit → owes ₹799.00.
6. Return it as store credit → owes ₹0.00.
7. Same customer pays ₹500 by UPI with nothing owed → advance ₹500.00.
8. A second customer (₹2,000 credit) buys 2 and pays ₹1,000 cash at the
   till → owes ₹598.00.
9. Walk-in bill: store credit is not offered on its return.
10. Exchange 1 for 1 of the same price → nothing to pay; new bill "Paid by
    Exchange".
11. Exchange 2 for 1 → ₹799.00 back in cash.
12. Exchange 1 for a dearer item → pay the difference.
13. Try to void a bill that has a return → no Void button.
14. Try to void an exchange bill → no Void button.
15. A cashier tries a return on a bill older than 7 days → refused; a manager
    can (marked late on the credit note). (Needs an old bill: test on a later
    day.)
16. Buy 10 from a supplier at ₹50 + 5%, send 4 back → owe ₹315.00, stock −4.
17. Send the other 6 back → owe ₹0.00; nothing more can go back.
18. A paid purchase, 2 sent back → the supplier owes you (advance).
19. Record rent ₹15,000; void it with a reason → total back to ₹0.00.
20. Log in as an accountant → sees expenses and bills, cannot record or
    return anything.

## Tests

- `tests/integration/customer-payments.test.ts`, `returns.test.ts`,
  `exchanges.test.ts`, `purchase-returns.test.ts`, `expenses.test.ts`,
  `stock-rebuild.test.ts`
- `src/lib/return-maths.test.ts` (including 3,000 random sequences of
  partial returns)
- Browser: `tests/flows/returns.spec.ts`, `purchases.spec.ts`,
  `expenses.spec.ts`, `pos.spec.ts`
- Isolation suites cover every new table.

## Phase 8 sign-off (2026-10-04)

The owner signed off Phase 8 to move on ("next"), on the strength of the
automated run of the hand test: `tests/flows/phase8-scenarios.spec.ts`
does the setup and scenarios 1–14 and 16–20 of
`docs/hand-tests/phase-8-hand-test.pdf` in a browser exactly as written and
checks every amount, balance and the final stock (passing). Scenario 15 is
covered by `tests/integration/returns.test.ts`.

**Before going live:** the owner goes through the PDF by hand (about 45
minutes) and reports anything marked "Different"; the accountant answers
questions 9–10 and 41–43.
