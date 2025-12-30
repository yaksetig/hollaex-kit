# Engine

This directory contains a standalone matching-engine implementation that mirrors the behaviour described in the "Matching Engine Functional Specification". The code is framework-agnostic JavaScript (CommonJS) so it can be deployed independently while preserving compatibility with the Kit's expectations for order-book processing.

## Contents
- `src/constants.js` – enums and error codes used throughout the engine.
- `src/events.js` – lightweight event classes and dispatcher used to broadcast lifecycle changes.
- `src/order.js` – order and price-level data structures (`SimpleOrder`, `Bucket`).
- `src/orderBook.js` – the core matching-engine logic for submitting, matching, cancelling, editing, persisting, and replaying orders.
- `src/persistence.js` – helpers to map runtime state into persisted representations and rebuild from snapshots (including to/from JSON helpers for storage).
- `src/orchestrator.js` – a higher-level coordinator that wraps the order book with authentication, persistence, network fan-out, and health hooks for private deployments.
- `index.js` – convenience exports.

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

### EngineOrchestrator
For private or siloed deployments, `EngineOrchestrator` provides a thin service layer that mirrors the responsibilities outlined in the network-replication spec:

- Injects authentication/authorization callbacks (`validateSession`, `validateSubscription`, `rateLimit`) before commands are forwarded to the engine.
- Accepts network adapters (`authenticate`, `publishPublicEvent`, `publishPrivateEvent`, `publishHealth`) so you can bridge REST/websocket calls to the HollaEx Network or run in `local-only` mode via feature flags.
- Persists lifecycle events (`persistOrder`, `persistOrderCancel`, `persistTrade`, `persistOrderReject`) and automatically snapshots order-book state to keep the engine restartable.
- Replays snapshots or open orders on startup to guarantee deterministic recovery before new flow is accepted.
- Emits private-topic updates (e.g., `order:<uuid>`) for downstream websocket servers while enforcing per-user subscription validation.

This keeps the engine folder self-contained while giving you authenticated command ingestion, persistence, replay, and network fan-out hooks without coupling the core matcher directly to the HollaEx Network.
