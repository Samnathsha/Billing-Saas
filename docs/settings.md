# Business setup and settings (Phase 4)

Decisions: docs/business-rules.md section 11. Open questions 26-28.

## Business settings: `/settings/business`

Owner and Admin only ("Business and tax settings"). Anyone else sees "Not
allowed", also when typing the address; the menu link is hidden for them as
a convenience only.

| Field | Rule |
|---|---|
| Business name | Required, up to 200 characters. |
| Address, second line, city | Optional, up to 200 / 200 / 100 characters. |
| State | GST state code from the list (`src/modules/tax/gst.ts`). |
| PIN code | 6 digits, not starting with 0. |
| Phone | Digits, spaces, `+` and `-`, 6 to 20 characters. |
| Email for customers | A valid address. |
| GST registration | Registered, composition or not registered. Required to save. Owner or accountant to validate. |
| GSTIN | Required when registered or composition, empty otherwise. Shape, state and check character are checked; it must belong to the chosen state. Typed spaces and lower case are cleaned up. |
| Selling prices include GST | Default on. Owner or accountant to validate (open question 28). |

| Bill prefix, credit note prefix | 1-4 letters or digits (typed lower case is made upper case), different from each other. Default `INV` and `CN`. The screen shows the first number of this year, e.g. `INV/26-27/00001`. Owner or accountant to validate. |

- Bill numbers: `PREFIX/YY-YY/NNNNN` (business rules section 12),
  `src/modules/sales/numbering.ts`. Locking a prefix after the year's first
  bill comes in Phase 7.
- Service: `getBusinessProfile(ctx)` and `updateBusinessProfile(ctx, input)`
  in `src/modules/tenants/service.ts`, both starting with
  `requirePermission(ctx, "settings.manage")`.
- One transaction: the settings row is locked, the page's `version` must
  still be current ("Someone else changed these settings meanwhile" if
  not), only changed fields are saved, and an audit entry
  `settings.profile_updated` records exactly those fields, before and after.
- The database repeats the key rules (migration 0010): GSTIN shape, GSTIN
  exactly when registered or composition, and its state equal to the
  business state.

## Plans and limits

- Pilot plan for every business: 2 branches, 10 staff (owner included), 5
  tills (business rules section 11; tables `plans`, `subscriptions`).
- `requireCapacity(tx, ctx, "branches" | "users" | "devices")`
  (`src/modules/tenants/entitlements.ts`): call it inside the same
  transaction that adds, after the permission check. It takes a per-business
  lock (so two simultaneous additions cannot both pass), counts open
  branches / active members / active tills, and refuses with
  `PlanLimitError` ("Your plan allows 2 branches...") when full. No active
  plan: refuses everything (fails closed).
- Used by branches (4.4), staff invitations (4.5) and tills (Phase 10).
  `npm run dev:add-member` (a development tool) does not check it.
- "Your plan" on Business settings: plan name and "used of limit" for each.

## Branches: `/settings/branches`

Owner and Admin only ("Business and tax settings"); others see "Not
allowed" and no menu link.

- Add (within the plan: pilot = 2 open branches), rename, close, reopen.
  Names: 1-100 characters, unique in the business ignoring capitals, also
  against closed branches (a closed branch keeps its name).
- Closing keeps the branch and its history (`archived_at`); it never
  deletes. The last open branch cannot be closed; a lock stops two people
  closing the last two at the same moment.
- Reopening counts against the plan like adding.
- Every change is audited: `branch.created`, `branch.renamed`,
  `branch.closed`, `branch.reopened`.
- Later rules: stock in a closed branch (Phase 6); staff limited to one
  branch (`memberships.branch_id`) when staff screens need it.

## Tests

- `src/modules/tax/gst.test.ts`: GSTIN check (published sample accepted;
  every single-character typo and neighbouring swap caught), state list.
- `src/modules/sales/numbering.test.ts`: number format, the 16-character
  limit, financial year at the India-time midnight boundary.
- `tests/integration/business-profile.test.ts`: defaults, saving and
  clean-up, audit of changed fields only, no-change saves, version guard,
  15 validation cases, Admin allowed and Manager/Cashier/Accountant refused,
  isolation between businesses, database checks. Verified to fail without
  the version guard, the right permission, the audit entry, or the
  GSTIN-state rule in the app or in the database. Prefixes: defaults,
  clean-up, audit, 5 refusals, database checks; verified to fail without
  the "different prefixes" rule or the clean-up.
- `tests/integration/plans.test.ts`: pilot numbers, new business counted,
  each limit reached and freed again, three simultaneous additions with
  only one fitting, no plan = nothing added, a shop cannot change plans or
  its subscription. Verified to fail without the lock, with an off-by-one
  limit, or without failing closed.
- `tests/integration/branches.test.ts`: add, plan limit, names, rename,
  close/reopen, last open branch, simultaneous closes, audit, Manager /
  Cashier / Accountant refused, other business's branches not found.
  Verified to fail without the last-branch rule, the closing lock, or the
  plan check on adding or reopening.
- `tests/flows/branches.spec.ts`: the whole screen in a real browser, and a
  cashier refused.
- `tests/isolation/*`: `subscriptions` is attacked like every tenant table;
  `plans` and `subscriptions` are out of the login role's reach.
- `tests/flows/business-settings.spec.ts`: fill in and reload; mistyped
  GSTIN refused next to the field; old page after someone else saved; a
  cashier has no link and gets "Not allowed". Verified to fail if the menu
  link is shown to everyone.
