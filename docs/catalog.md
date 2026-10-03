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

## Barcodes and search (step 5.3)

- A barcode is unique among active barcodes of a business: a scan finds
  exactly one item. Removing archives it and frees the code. Several per
  variant allowed.
- Search (Products page): name contains (any case), SKU starts with, or
  exact barcode; LIKE wildcards are matched literally; 50 per page. A
  scanned barcode in the search box opens its item directly.

## CSV import (step 5.4): `/catalog/import`

- One line per variant; lines with the same product name form one product
  (product-level columns must agree across its lines).
- Required columns: `product_name, unit, tax, sku, selling_price`.
  Optional: `category, brand, hsn, size, colour, fabric, model, ram,
  storage, warranty_months, track_imei, mrp, cost, reorder_level, barcode`.
  Prices in rupees. Unit = unit code; tax = rate code or name.
- Categories, brands and units must exist (never created by an import).
- All or nothing: every line is checked first (also against SKUs and
  barcodes already in use); any problem = nothing imported and every
  problem listed with its line. Otherwise all products are created in one
  transaction, each audited as `product.created`, plus `product.imported`.
- Limits: 2 MB, 2,000 lines.

## Serial numbers and shop type (step 5.6)

- `serial_numbers` (IMEI per unit): structure only; filled by purchases in
  Phase 6, changed by sales and returns.
- Shop type (clothing / mobile): changeable on Business settings only while
  no product exists. "Prices include GST" locks at the same moment (open
  question 28).

## Logo and product photos (step 5.5)

- PNG, JPEG or WebP only, judged by content (first bytes and a real
  decode); at most 2 MB; re-encoded to WebP (strips metadata such as GPS,
  and anything appended), at most 1600 x 1600. A renamed `.exe` is refused.
- Stored privately under a random business-prefixed key; viewed only at
  `/api/files/<id>` by logged-in members of the same business.
- Logo: one at a time (Business and tax settings). Product photos: up to 8
  per product (Manage products). Audited.
- Storage today: a local folder `.local-files/` (git-ignored) standing in
  for Cloudflare R2. **To switch to R2 (owner):** create the Cloudflare
  account and an R2 bucket, create an API token for that bucket only, put
  the keys in `.env.local` (never in chat), then the R2 adapter replaces
  the two functions in `src/modules/files/store.ts`.

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
- `tests/integration/catalog-search.test.ts`: barcodes and search
  (verified to fail without wildcard escaping).
- `src/modules/catalog/csv.test.ts`, `csv-import.test.ts`,
  `tests/integration/catalog-import.test.ts`: CSV reading, a 500-line file,
  one bad line of 500 imports nothing (verified to fail without the
  all-or-nothing rule), clashes, cashier refused.
- `tests/integration/shop-type.test.ts`: switching and the locks.
- `src/modules/files/images.test.ts`, `tests/integration/files.test.ts`:
  renamed .exe, fake PNG, SVG/GIF, oversized, metadata stripped, resize;
  logo and photos, permissions, other businesses, per-product limit.
- `tests/isolation/*`: categories, brands, units, products, variants,
  barcodes, serial numbers and files attacked like every
  tenant table; tax tables and catalog lists out of the login role's reach.
