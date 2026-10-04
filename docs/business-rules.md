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
    `INV/26-27/00001` (format: section 12).
5.2 Each till or device gets its own prefix, so numbers never clash between
    tills (needed for offline later).
5.3 The counter (`invoice_sequences`) is incremented inside the sale
    transaction with a row lock. A rolled-back sale does not use up a number.
5.4 Credit notes (returns) have their own series, for example
    `CN/26-27/00001`.

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

### 10. Staff access (owner decision 2026-10-02)

- Changing a staff member's role or deactivating them needs "Manage users"
  (Owner and Admin by default). Admins may manage other Admins.
- Nobody can change or deactivate the Owner, and nobody can change or
  deactivate themselves.
- Any role except Owner can be given. Making someone Owner is "transfer
  ownership", a separate Owner-only action (later).
- After a role change or deactivation, ALL the person's logins end at once
  on every device; they log in again with the new role.

### 11. Phase 4 decisions (owner, 2026-10-02)

- **Logo:** built in Phase 5 together with product photos, on Cloudflare
  R2 (one storage account for both). No logo upload in Phase 4.
- **Pilot plan:** every business is on one free plan during the pilot:
  at most 2 branches, 10 staff (active members, owner included) and 5
  tills (devices). The numbers live in the `plans` table and can be changed
  without code. No payment integration yet.
- **Shop type (clothing / mobile):** can be changed only until the first
  product exists; after that it is locked. (The switch is built with the
  catalog in Phase 5, where products exist to check.)

### 12. Bill numbers (owner decision 2026-10-02; replaces the example in 5.1)

- Format `PREFIX/YY-YY/NNNNN`, e.g. `INV/26-27/00001`; credit notes the
  same with their own prefix, e.g. `CN/26-27/00001`. The blueprint's
  `INV-2026-27-000001` was 18 characters, over the 16-character GST limit.
- Prefix: 1-4 capital letters or digits; bills and credit notes must use
  different prefixes. Defaults `INV` and `CN`. A till's own prefix (Phase
  10) follows the same rule.
- Financial year label from the business's financial year in its time zone
  (1 April, India time). Numbers restart at 00001 each year (open question
  20); at most 99,999 per series per year.
- A prefix can be changed freely until the first bill of the financial year;
  after that, a change only applies from the next 1 April (enforced in Phase
  7, when bills exist).

### 13. Catalog (owner decisions 2026-10-02, Phase 5)

- **Cost price on a product variant** is a *starting cost*: typed by the
  owner, used for opening stock and profit until real purchases (Phase 6)
  take over with the weighted average cost (rule 7.3). Only roles with
  "View cost price and profit" (Owner, Admin, Manager, Accountant) ever see
  it; the server leaves it out for everyone else.
- **New permission "Manage products"** (`products.manage`): create and edit
  products, variants and barcodes, and the catalog lists. Given to Owner,
  Admin and Manager (also added to existing businesses). Changing a selling
  price still also needs "Change a selling price" (`prices.change`).
- **Photos:** logo and product photos on Cloudflare R2 as the last step of
  Phase 5; the owner creates the account then, keys only in `.env.local`.

### 14. Stock and purchases (owner decisions 2026-10-03, Phase 6)

- **Purchase cost and GST:** a GST-registered (regular) business records
  purchase cost WITHOUT GST (claimed back as input tax credit); a
  composition or unregistered business records cost INCLUDING the GST paid.
  Accountant to confirm.
- **Wrong purchase:** never edited. A Manager or above voids the whole
  purchase with a reason; new entries reverse its stock and the supplier
  balance; then the correct purchase is entered. Refused if any of that
  stock is no longer there (e.g. already sold).
- **Transfers between branches:** later (Phase 8). Phase 6 keeps stock per
  branch; purchases, opening stock and adjustments go into a chosen branch.
- Stock never goes below zero for online work (rule 7.1). Quantities in a
  whole-piece unit must be whole numbers; IMEI items move one unit at a
  time.
- **As built (Phase 6):** purchases need the business's GST registration to
  be set first (it decides the cost rule). The same supplier bill number
  cannot be entered twice for one supplier (ignoring case) unless the first
  was voided. Voiding needs both "Create purchase" and "Void a posted
  invoice". Money paid stays paid when a bill is voided (see question 34).
  IMEI numbers of a voided purchase may be entered again. A supplier's
  balance is always the sum of its account rows: opening balance,
  purchases, payments and voids; never a typed number.

### 15. Billing and POS (owner decisions 2026-10-03, Phase 7)

- **Credit sales:** Phase 7 adds basic customers (name, phone, optional
  GSTIN, credit limit). A bill may be partly or fully on credit, never
  above the customer's limit (what they already owe counts). Customer
  payments and full customer profiles come in Phase 8.
- **Price at the till:** the bill always uses the product's current price.
  The person at the till may only give a discount within their limit
  (rule 8); prices change only on the Products page. A price sent by the
  browser is ignored; the server recomputes everything (rule 3.6).
- **Void window:** a Manager or above may void a bill only on the day it
  was made (business time zone). After that, mistakes are fixed with a
  return and credit note (Phase 8). Accountant to confirm.
- **Conventional choices (not asked):** card and UPI are recorded, not
  charged (no payment gateway); the bill date is always the moment of sale
  (no back-dating); each sale comes from one branch chosen at the till.

### 16. Returns, payments and expenses (owner decisions 2026-10-03, Phase 8)

- **Return window:** 7 days from the bill date (business time zone). After
  that the till refuses the return; a Manager or above may still do it
  (recorded in the audit log). The number of days is a business setting.
- **Refund:** the cashier chooses per return: money back (cash, UPI or
  card) or store credit on the customer's account (a customer must be
  chosen). Every return gets a credit note number from its own series
  (`CN/26-27/00001`), whichever way the money goes.
- **Expenses:** recorded by Manager and above (Owner, Admin, Manager);
  the Accountant can view them; a Cashier cannot.
- Never more can be returned than was sold, counting earlier returns;
  returned IMEI items must be the ones sold on that bill.

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
4. **Series format:** is `INV/26-27/00001` (at most 16 characters: letters,
   digits, `/` and `-`) acceptable for GST invoice numbers? DEFAULT,
   accountant to confirm: yes (section 12).
5. **Round-off:** should the round-off line be on by default, and is it
   shown as "Round off" outside taxable value? DEFAULT, accountant to
   confirm: on, nearest rupee, not taxed.
6. **Discount and tax:** is tax calculated on the price after a line
   discount? DEFAULT, accountant to confirm: yes, discount reduces the
   taxable value.
7. **Bill-level discount:** how is a whole-bill discount spread across lines
   with different rates? DEFAULT, accountant to confirm: in proportion to
   each line's value after its own discount. Each line's share is rounded
   down to the paisa; the paise left over go one at a time to the lines
   with the largest leftover fractions (so the shares always add up exactly
   and no line gets more than its value). (Phase 7 as built; replaces
   "remainder on the largest line".)
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
24. **Average cost precision:** stock bought at ₹100 for 3 pieces costs
    ₹33.333 each. Is weighted average cost kept in whole paise, or with
    extra decimals and rounded only on reports? DEFAULT, accountant to
    confirm: extra precision for average cost only; invoice and ledger
    amounts stay whole paise. (docs/schema.md, R3)
25. **MRP:** must products carry an MRP (maximum retail price), and must it
    appear on the bill or tag for our clients' goods? DEFAULT, accountant to
    confirm: optional MRP field per variant, not printed until confirmed.
    (docs/schema.md, R4)
26. **GST state list and GSTIN check:** the app offers the GST state codes
    01–24, 26, 27, 29–38 and 97 (not 25, 28 or 99) and checks a GSTIN's
    shape, state and check character. Is this list right for our clients?
    DEFAULT, accountant to confirm: yes (src/modules/tax/gst.ts).
27. **Name on the invoice:** must the invoice show the legal name from the
    GST registration, or is the shop's trade name enough? DEFAULT,
    accountant to confirm: the business name from settings; a separate
    legal-name field can be added.
28. **Changing "prices include tax" later:** once products have prices,
    switching this changes what every stored price means. DEFAULT, owner and
    accountant to confirm: allowed freely until the first product exists,
    then locked like the shop type (enforced in Phase 5).
29. **Price of zero:** may a product be sold for ₹0 (a free item)? DEFAULT,
    owner and accountant to confirm: no; the lowest selling price is 1
    paisa (database check). A free gift can be handled as a discount later.
30. **Selling price above MRP:** must the selling price never exceed the
    MRP printed on the item (Legal Metrology)? DEFAULT, accountant to
    confirm: yes; if an MRP is entered, the selling price must be at or
    below it (database check).
31. **Unit or serial tracking after stock exists:** changing a product's
    unit (e.g. pieces to metres) or IMEI tracking after it has stock would
    change what the stock numbers mean. DEFAULT, owner to confirm: allowed
    while no stock exists; locked once stock exists. (As built so far: the
    unit and IMEI tracking cannot be changed at all once the product is
    created; to change them, archive it and create a new product.)
32. **Rounding on purchase bills:** the app works out each line as quantity
    x price before GST, then GST on that line, each rounded half up to the
    paisa; the bill total is the sum of the lines. A supplier's printed
    bill may differ by a few paise (some round per bill, some add a
    "round off"). DEFAULT, accountant to confirm: the app's figures are
    kept; a "round off" line on purchases can be added if needed.
33. **Purchase price entry:** the price per unit is typed BEFORE GST, after
    any trade discount on the supplier's bill (no separate discount
    column). DEFAULT, owner to confirm.
34. **Paying a supplier more than we owe, and voided bills that were
    paid:** the extra stays as an advance with that supplier (a negative
    balance) and is used up by the next bills. DEFAULT, accountant to
    confirm: yes; a refund from the supplier can be recorded later.
35. **Bill and payment dates:** may be any day from 1 July 2017 (start of
    GST) up to today in the business's time zone; not in the future.
    DEFAULT, owner to confirm.
36. **Equal CGST and SGST:** for a same-state sale the app computes CGST
    on the taxable value at half the rate, rounded half up, and SGST is the
    same amount, so the two are always equal (the tax is then always an
    even number of paise). For prices including GST, the taxable value is
    the price minus CGST and SGST, so the line still costs exactly the
    price shown. DEFAULT, accountant to confirm.
37. **Bill of supply:** a composition or unregistered business charges no
    GST on its bills (the price is the total). DEFAULT, accountant to
    confirm (and the wording printed on such a bill, Phase 7 step 7.7).
38. **Discount limit check:** the cashier's limit (5%) applies to the whole
    bill's discount and also to each line's own discount, both measured
    against the price before discount. DEFAULT, owner to confirm.
39. **Who may give credit:** anyone who sells may add a customer at the
    till, but only roles with "Discount above limit" (Manager, Admin,
    Owner) may set or change a customer's credit limit or archive a
    customer. A customer may not owe more than their limit after a sale.
    DEFAULT, owner to confirm.
40. **Bill prefix after the first bill:** once this financial year's first
    bill (or credit note) has a number, its prefix cannot be changed until
    the next 1 April; the change is refused with that message (simpler
    than a change "scheduled" for April). DEFAULT, owner to confirm.
41. **Customer payments:** a payment is dated the day it is recorded (no
    back-dating); paying more than owed leaves an advance on the
    customer's account, used by later credit sales; any cashier may take a
    payment. DEFAULT, owner and accountant to confirm.
42. **Goods sent back to a supplier:** the amount comes off what we owe at
    the purchase line's own price and GST (partial returns add up exactly
    to the line). The goods leave stock at the current average cost (rule
    7.3), not at that purchase's price. The app records the supplier's own
    note number if given but does not issue its own debit note numbers.
    DEFAULT, accountant to confirm (and whether a numbered debit note is
    needed).
43. **Expenses and GST:** an expense is recorded as one amount (what was
    paid); any GST on it (e.g. on a repair bill) is not tracked separately
    for input tax credit. Expenses may be dated in the past (not the
    future). DEFAULT, accountant to confirm.