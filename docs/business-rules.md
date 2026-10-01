# Business Rules

Source: docs/blueprint.md (sections 2, 7 and 8) plus owner answers recorded
on 2026-10-01. Rules marked **DEFAULT, accountant to confirm** are the
suggested default until the accountant says otherwise. Nothing here is legal
or tax advice; the accountant signs off before launch.

## DECIDED

### 1. Country, currency and calendar

1.1 First configuration: India, INR, GST. Country and tax rules are data,
    not code, so other countries can be added later.
1.2 Money is stored as integer paise (`bigint`). 12.50 is stored as 1250.
    No floating point for money, ever.
1.3 Quantities are `numeric(14,3)`; tax rates are `numeric(7,4)`.
1.4 Financial year: 1 April to 31 March.
1.5 Times are stored in UTC. The business time zone (default Asia/Kolkata)
    is a setting used for display and day boundaries only.
1.6 Language: English only for now.

### 2. Business type

2.1 First business template: clothing shop (variants by size, colour, brand,
    fabric; variant-level SKU, barcode, price and stock; exchange = return
    plus new sale in one transaction).
2.2 Mobile shop (IMEI per unit, warranty) comes later. The schema keeps
    `serial_numbers` ready for it.

### 3. Pricing and rounding

3.1 Prices are tax-inclusive by default (retail prices include tax). This is
    a per-business setting.
3.2 Tax is calculated per invoice line and rounded half up to the nearest
    paisa.
3.3 Tax-inclusive line: net = round(gross / (1 + rate)), tax = gross - net,
    so lines always add up exactly.
3.4 Tax-exclusive line: tax = round(net x rate).
3.5 An optional round-off line brings the invoice total to the nearest
    rupee and is shown separately on the invoice.
3.6 The same pure calculation function runs in the browser (cart preview)
    and on the server (the authority). The server always recomputes.

### 4. Tax rates

4.1 Tax rates are never hardcoded. They live in a `tax_rates` table with
    effective-from and effective-to dates, so a rate change never alters
    old invoices.
4.2 A rate row can carry a price range per piece, to support clothing slabs
    that depend on price.
4.3 Development uses clearly labelled TEST rates only: `TEST 5%` and
    `TEST 18%`. Real rates and the clothing price-based slabs come from the
    accountant before launch.
4.4 Same-state sales split tax into equal CGST and SGST; other-state sales
    carry IGST. The split is stored on each invoice line.
4.5 Business settings: GSTIN, registered state, registered or unregistered,
    composition scheme, tax-inclusive pricing.
4.6 HSN code is stored per product and printed on the invoice.
4.7 Invoice lines store a snapshot of name, price, tax rate and cost at the
    time of sale.

### 5. Invoice numbering

5.1 One series per business per financial year, for example
    `INV-2026-27-000001`.
5.2 Each till or device gets its own prefix, so numbers never clash between
    tills (needed for offline later).
5.3 The counter (`invoice_sequences`) is incremented inside the sale
    transaction with a row lock. A rolled-back sale does not use up a number.
5.4 Credit notes (returns) have their own series, for example
    `CN-2026-27-000001`.

### 6. Posted invoices

6.1 Posted invoices are never edited or deleted.
6.2 Mistakes are fixed by void (manager permission or higher, reason
    required) or by a credit note.
6.3 A void inserts reversing stock, payment and ledger entries; the original
    rows stay unchanged.

### 7. Stock

7.1 Negative stock is blocked for online sales.
7.2 An offline sale that already happened is accepted at sync time and
    flagged for a manager, never silently dropped.
7.3 Cost method: weighted average cost, stored on each stock movement so
    profit reports stay stable.
7.4 The stock ledger (`stock_movements`) is append-only and is the source of
    truth; `stock_balances` is a cache rebuilt from it.

### 8. Discounts

8.1 Cashier: up to 5% discount.
8.2 Manager, Admin and Owner: unlimited.
8.3 The cashier limit is a per-business setting.
8.4 The server checks the discount against the user's limit on every sale.

### 9. Offline

9.1 Offline selling is built later (Phase 10), not now.
9.2 Rules that apply from the first sales endpoint anyway: records get
    their UUID on the device, every write takes a `client_op_id` and is
    idempotent, and the server never trusts client money figures.

## OPEN QUESTIONS FOR ACCOUNTANT

Each question has the default the app will use until answered.

1. **Clothing GST slabs:** what are the current rates and price-per-piece
   thresholds for clothing and footwear? DEFAULT: TEST 5% / TEST 18% only;
   no real rates until supplied.
2. **Slab price basis:** is the slab decided on the price after discount or
   before? DEFAULT, accountant to confirm: after discount, per piece.
3. **Parallel series:** are several invoice series running at once (one per
   till) acceptable for GST? DEFAULT, accountant to confirm: yes, one prefix
   per till.
4. **Series format:** is `INV-2026-27-000001` within the GST length and
   character limits for invoice numbers? DEFAULT, accountant to confirm: yes,
   letters, digits and hyphens only, 16 characters or fewer.
5. **Round-off:** should the round-off line be on by default, and is it
   shown as "Round off" outside taxable value? DEFAULT, accountant to
   confirm: on, nearest rupee, not taxed.
6. **Discount and tax:** is tax calculated on the price after a line
   discount? DEFAULT, accountant to confirm: yes, discount reduces the
   taxable value.
7. **Bill-level discount:** how is a whole-bill discount spread across lines
   with different rates? DEFAULT, accountant to confirm: in proportion to
   each line's value, rounded half up, remainder on the largest line.
8. **Void time limit:** may an invoice be voided after its GST return
   period is filed, or must it then be a credit note? DEFAULT, accountant to
   confirm: void allowed only on the same business day; after that, credit
   note only.
9. **Credit note tax:** does a credit note reverse tax at the rate on the
   original invoice? DEFAULT, accountant to confirm: yes, from the original
   line snapshot.
10. **Credit note time limit:** is there a deadline for issuing a credit
    note against an old invoice? DEFAULT, accountant to confirm: no limit
    enforced by the app; the accountant reviews old ones.
11. **Exchange:** should an exchange show as one credit note plus one new
    invoice? DEFAULT, accountant to confirm: yes.
12. **Damaged returns:** what cost is used for goods returned as damaged
    (scrap)? DEFAULT, accountant to confirm: weighted average cost at the
    original sale, written off with a reason code.
13. **Return stock cost:** what cost does a resellable return come back in
    at? DEFAULT, accountant to confirm: the cost snapshot from the original
    sale line.
14. **Composition scheme:** for a composition business, what must the bill
    say and must it be titled "Bill of Supply"? DEFAULT, accountant to
    confirm: no tax charged, titled "Bill of Supply" with the required
    declaration.
15. **Unregistered business:** what document title and wording does an
    unregistered shop use? DEFAULT, accountant to confirm: "Invoice" with no
    GST lines.
16. **HSN digits:** how many HSN digits must be printed for our clients'
    turnover? DEFAULT, accountant to confirm: 4 digits; setting allows 6 or 8.
17. **B2B invoices:** what extra fields are required when the customer gives
    a GSTIN? DEFAULT, accountant to confirm: customer name, address, GSTIN
    and place of supply.
18. **Place of supply:** for a walk-in retail sale, is place of supply always
    the shop's state? DEFAULT, accountant to confirm: yes (CGST + SGST).
19. **E-invoicing:** at what turnover must a client use e-invoicing? DEFAULT,
    accountant to confirm: not built; a marked hook only.
20. **Series reset:** do series restart at 000001 every 1 April? DEFAULT,
    accountant to confirm: yes, new financial year = new series.
21. **Negative stock cost:** what cost is used for an offline sale that
    took stock below zero? DEFAULT, accountant to confirm: the last known
    weighted average cost, corrected when the next purchase arrives.
22. **Weighted average scope:** is average cost kept per branch or for the
    whole business? DEFAULT, accountant to confirm: per branch.
23. **Branches in other states:** GST registration (GSTIN) is per state, so a
    branch in a second state needs its own GSTIN and its own invoice series,
    and CGST/SGST vs IGST depends on that branch's state. DEFAULT, accountant
    to confirm: V1 supports branches in the business's registered state only;
    GSTIN and state stay business settings, not branch settings.
