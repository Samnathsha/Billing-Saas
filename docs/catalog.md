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

## Tests

- `tests/integration/tax-rates.test.ts`: only TEST rates, no overlapping
  rates (verified to fail when an overlapping rate is added), the app cannot
  change rates or categories.
- `tests/integration/catalog-lists.test.ts`: starting units, categories and
  subcategories, names, rename, archive/restore, no delete, Cashier and
  Accountant refused, Manager allowed, other business's items not found.
  Verified to fail if sub-sub-categories, duplicate names or the wrong
  permission are allowed.
- `tests/isolation/*`: categories, brands and units attacked like every
  tenant table; tax tables and catalog lists out of the login role's reach.
