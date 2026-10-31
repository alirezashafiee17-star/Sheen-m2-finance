# Sheen inventory

Inventory is a module within the existing application, using its PostgreSQL database and authentication. It starts empty; no demo records are imported. Existing financial records and access settings remain intact.

## Access

Only the owner grants inventory access, edit rights, price visibility, and a scope (`services`, `gallery`, or `both`) in member management. All defaults are disabled. Inventory-only accounts do not need finance or showroom access. Entry-only finance accounts cannot also receive inventory access. Price fields and financial links are stripped by the server for accounts without price permission.

## Stock and cost

Each item has a scope-specific SKU, optional barcode, base unit, purchase unit, conversion factor, minimum stock, and location. Units/conversion are fixed after creation to preserve historical quantities. Purchases carry the total cost after discount. Quantities support three decimal places; consumption uses a moving weighted average at registration time, with costs recorded in whole tomans.

Movements are immutable. Consumption returns restore original cost. Owner-only physical counts correct discrepancies with a reason. Inter-warehouse transfers move both stock and its carrying value atomically. Tools on loan remain owned stock and retain value, while their quantities are excluded from available stock. All changes record the actor and time; requests have idempotency keys and row locks protect available stock.

Vehicle dossiers record material cost separately from financial payments. Gallery dossiers can link to an existing showroom vehicle; the showroom's car card opens its inventory dossier. Service dossiers can carry a plate and reception/order number.

## Finance

A services purchase can optionally create exactly one expense payment, or link an existing expense with a matching paid amount, with finance-edit permission. Partial payment is allowed. A purchase without payment does not create a cash expense. One existing payment cannot be attached twice. Stock and expense creation commit together. Linked expense edits/deletions are blocked; use separate correcting finance entries if required.

Consumption does not create a second cash expense. Vehicle material cost is shown separately, and is not automatically added to legacy showroom deal expenses, which might already include materials. This preserves current cash-based reports and avoids silently changing old profit calculations. This release does not include a supplier payable ledger, multi-line invoice settlement, camera barcode scanning, or automatic expiry alerts; SKU/barcode lookup, invoice reference, expiry metadata and serial/batch references are available.

## Deployment and verification

The database migration runs idempotently during startup and only adds new tables/columns/indexes. Deploy the repository's Docker image as usual. No new environment variables or runtime dependencies are needed. `npm ci && npm test` runs endpoint, PostgreSQL SQL, cost/permission/idempotency tests and full application form/login integration using PGlite and JSDOM. Test data is isolated and does not touch production.
