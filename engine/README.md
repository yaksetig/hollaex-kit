# Engine

This directory contains a standalone matching-engine implementation that mirrors the behaviour described in the "Matching Engine Functional Specification". The code is framework-agnostic JavaScript (CommonJS) so it can be deployed independently while preserving compatibility with the Kit's expectations for order-book processing.

## Contents
- `src/constants.js` – enums and error codes used throughout the engine.
- `src/events.js` – lightweight event classes and dispatcher used to broadcast lifecycle changes.
- `src/order.js` – order and price-level data structures (`SimpleOrder`, `Bucket`).
- `src/orderBook.js` – the core matching-engine logic for submitting, matching, cancelling, editing, persisting, and replaying orders.
- `src/persistence.js` – helpers to map runtime state into persisted representations and rebuild from snapshots.
- `index.js` – convenience exports.

### Custom Network Backend (API Shim)

The `src/backend` folder contains a stub-friendly REST + WebSocket server that mirrors the surface area expected by `hollaex-network-lib`.
It provides deterministic order creation/cancellation, fixed-point balance accounting, and immediately usable endpoints/websocket topics for Phase 1 compatibility.

- `src/backend/server.js` – Express entrypoint exposing `/v2/network` routes and `/stream` websocket channel.
- `src/backend/routes.js` – REST handlers covering the network-lib surface (tickers, orderbook, trades, orders, balances, deposits/withdrawals, udf/chart endpoints, etc.).
- `src/backend/data-store.js` – in-memory ledger, balances, orders, trades, and idempotency cache with fixed-point arithmetic helpers.
- `src/backend/websocket.js` – channel subscription handling for orderbook, trades, order:<userId>, and wallet:<userId> topics with partial snapshots.
- `src/backend/tests/runTests.js` – deterministic fixture checks for idempotent order creation, cancellation, and numeric round-tripping.
- `db/schema.sql` and `db/migrations/001_init.sql` – starter schema and migration for persisting the stubbed models when wiring to a database.
- `Dockerfile.backend` and `docker-compose.yml` – local runtime scaffolding for the backend shim.

## Usage
The engine is designed to be embedded in a service that exposes REST and websocket endpoints. A minimal usage example:

```js
const { SimpleOrderBook, EventDispatcher, MATCH_CONSTRAINTS, ORDER_TYPES, DIRECTIONS } = require('./engine');

const dispatcher = new EventDispatcher();
dispatcher.on('TradeEvent', (event) => console.log('trade', event));

const book = new SimpleOrderBook({ leftSideName: 'BTC', rightSideName: 'USDT' }, dispatcher);

book.submitOrder({
  price: 30000,
  quantity: 1,
  matchConstraint: MATCH_CONSTRAINTS.GTC,
  orderType: ORDER_TYPES.LIMIT_ORDER,
  direction: DIRECTIONS.BID,
  ouid: 'client-order-1',
  uuid: 'user-123'
});
```

The dispatcher delivers domain events as plain objects, letting callers persist trades, broadcast websocket updates, or reject invalid commands. See inline comments for behaviour aligned with the supplied specification.
