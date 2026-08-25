# orderdesk

A small order-desk service for a smithing catalogue. Carts hold items, pricing
computes totals against the stock catalogue, orders snapshot a cart, and
notification builds the confirmation email a customer receives.

## Layout

- `src/inventory.js` — the catalogue: every product, its price and on-hand
  stock. One source of truth; nothing in this project writes it.
- `src/pricing.js` — subtotal and total (with tax) for a list of items.
- `src/cart.js` — the shopping cart and the discount helper.
- `src/orders.js` — turning a cart into an order (snapshotting what was
  ordered) and editing an order afterwards.
- `src/notify.js` — the confirmation email a customer gets for an order.
- `src/auth.js` — token issue and validation for desk operators.
- `src/session.js` — operator sessions, built on auth tokens.
- `src/reports.js` — text reports of items for the back office.

## Tests

`node test.js` runs every module's tests and exits non-zero on any failure.
Each module's tests live beside the suite in `tests/`.
