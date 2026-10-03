# Catalog (Phase 5)

Decisions: docs/business-rules.md section 13. Permission "Manage products"
(`products.manage`: Owner, Admin, Manager) for everything here.

## Tax rates (step 5.1a)

Global, read-only for the app (`tax_categories`, `tax_rates`, migration
0015). Only `TEST 5%` and `TEST 18%` until the accountant supplies real
categories and slabs. See docs/schema.md section 4.

## Categories, brands, units (step 5.1b)

Service: `src/modules/catalog/service.ts`.

- `getCatalogLists`, `createCategory`, `createBrand`, `createUnit`,
  `renameListItem`, `setListItemArchived` (archive or restore).
- Names unique per business ignoring case, also against archived ones;
  unit codes too. Subcategories one level deep. Archived items stay listed
  as inactive; nothing is deleted.
- Every change audited (`catalog.<kind>_created/_renamed/_archived/_restored`).

Screen: `/catalog/lists` ("Catalog" in the menu, "Manage products" only;
others "Not allowed"): add, rename, archive and restore categories (with
an optional main category), brands and units (code, fractions).

## Products and variants (step 5.2)

Service: `src/modules/catalog/products.service.ts` (the permission lint
rule covers every `*.service.ts`).

| Action | Needs |
|---|---|
| Look up products (`getProduct`, `listProducts`) | Any of: Manage products, Create sale, Reports |
| See cost price | View cost price and profit (others never receive it) |
| Create a product, add a variant | Manage products and Change a selling price (+ View cost price to enter a cost) |
| Edit product details, edit a variant's SKU/details/reorder level, archive/restore | Manage products |
| Change selling price / MRP / cost | Change a selling price (+ View cost price for the cost) |

- Money in paise, whole numbers: at least 1 paisa (open question 29); MRP,
  if entered, never below the selling price (open question 30).
- Template fields checked strictly per business template
  (`src/modules/catalog/templates.ts`); unknown fields refused. Variant
  names are built in a fixed order (clothing: size / colour / fabric;
  mobile: RAM / storage / colour).
- Two variants of one product may not have the same details; SKUs unique
  per business ignoring case.
- IMEI/serial tracking only with a unit sold in whole pieces.
- Edits use a version guard ("Someone else changed this meanwhile").
- Audited: `product.created`, `product.updated`, `product.variant_added`,
  `product.variant_updated`, `product.price_changed` (old and new values),
  `product.archived/restored`, `product.variant_archived/restored`.
- Changing the unit or IMEI tracking after creation is not offered yet
  (open question 31: locked once stock exists, Phase 6).

## Tests

- `tests/integration/tax-rates.test.ts`: only TEST rates, no overlapping
  rates (verified to fail when an overlapping rate is added), the app cannot
  change rates or categories.
- `tests/integration/catalog-lists.test.ts`: starting units, categories and
  subcategories, names, rename, archive/restore, no delete, Cashier and
  Accountant refused, Manager allowed, other business's items not found.
  Verified to fail if sub-sub-categories, duplicate names or the wrong
  permission are allowed.
- `tests/flows/catalog-lists.spec.ts`: the Lists screen in a real browser
  (subcategory, duplicate refused, unit, archive/restore) and a cashier
  refused.
- `src/modules/catalog/templates.test.ts`: template fields per shop type.
- `tests/integration/products.test.ts`: creating (clothing and mobile),
  price and cost rules, identical variants, SKUs, list items, IMEI and
  units, cost hidden from cashiers, accountant sees cost but cannot price,
  manager allowed, price-change audit, version guards, variants, archive,
  other businesses, database checks. Verified to fail if the cost is shown
  to everyone, the wrong permission may change prices, price changes are
  not audited, or identical variants are allowed.
- `tests/isolation/*`: categories, brands, units, products and variants
  attacked like every
  tenant table; tax tables and catalog lists out of the login role's reach.
