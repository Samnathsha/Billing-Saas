# Onboarding a new client (Phase 12)

A checklist for each new shop. Tick each line. It takes about 2 hours with
the shop owner, plus a few days of watching.

## Before the visit

- [ ] Hosting and database are on a plan that allows business use
      (decision 0007), with a spending alert.
- [ ] Production checks are green: last deploy log entry, Reconcile and
      Backup workflows passed in the last 24 hours.
- [ ] The lawyer has approved `/terms` and `/privacy` (open question 52).
- [ ] Agree with the owner: plan and price, start date, how they pay.
- [ ] Ask the owner for:
  - business name and address;
  - GSTIN and registration type;
  - bill prefix wanted;
  - their staff (names, emails, roles);
  - their item list (a spreadsheet is fine);
  - opening stock counts.

## With the owner

1. [ ] The owner creates their account (register page) and confirms their
       email.
2. [ ] Business setup: name, shop type (clothing or mobile).
3. [ ] Business settings: address, state, GST registration, GSTIN,
       "prices include GST", bill and credit-note prefixes. **Check one
       sample bill with their accountant before going live.**
4. [ ] Two-step login switched on for the owner (recommended).
5. [ ] Branches (if more than one).
6. [ ] Products: import the item list (Products → Import) or add them;
       check prices and GST rates on 5 random items.
7. [ ] Opening stock: count, enter, and compare the Stock page with the
       count.
8. [ ] Staff: invite each person with the right role (Cashier, Manager,
       Accountant…).
9. [ ] Tills: on each till computer, Tills → "Register this computer",
       then open New bill once while online.
10. [ ] A test bill: sell one item, print the bill, and check it with the
        owner (amounts, GST, address, number). Then void it (same day).
11. [ ] Show:
    - a return;
    - a customer on credit and their payment;
    - offline billing (Wi-Fi off, one bill, Wi-Fi on, it syncs);
    - the dashboard and reports;
    - "Offline bills to check".
12. [ ] Give the owner the short guides: hand-test PDFs (Phases 8 and
        10–11) and a one-page "how to" (to write with the first client).

## First two weeks (pilot)

- [ ] Every evening the owner compares the app's day (Reports → Sales by
      day, payments by method, stock of 5 items) with their own book.
      Write down every difference.
- [ ] Every morning check:
  - the Reconcile workflow (must be clean);
  - Sentry (new errors?);
  - "Offline bills to check".
- [ ] Fix every difference before charging (blueprint "done when": two
      weeks with zero unexplained differences).
- [ ] Run the restore drill once in this period (`docs/backups.md`).

## After going live

- [ ] Note the client, start date and plan in your records.
- [ ] Monthly: restore drill, update check (Dependabot pull requests), a
      look at database size and hosting costs.
