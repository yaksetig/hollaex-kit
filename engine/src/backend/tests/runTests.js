const assert = require('assert');
const { DataStore } = require('../data-store');
const { toAtomic, toDisplay } = require('../amounts');

const store = new DataStore();

const userId = '42';
store.createUser('test@example.com');
store.setBalance(userId, 'usdt', toAtomic('1000'));
store.setBalance(userId, 'xht', toAtomic('50'));

const initialWallet = store.getBalance(userId, 'usdt');

const orderA = store.createOrder({
  user_id: userId,
  symbol: 'xht-usdt',
  side: 'buy',
  size: '1',
  type: 'limit',
  price: '10',
  client_order_id: 'fixed-order-1',
});

const orderB = store.createOrder({
  user_id: userId,
  symbol: 'xht-usdt',
  side: 'buy',
  size: '1',
  type: 'limit',
  price: '10',
  client_order_id: 'fixed-order-1',
});

assert.strictEqual(orderA.id, orderB.id, 'Idempotent creation should return same order id');
assert.strictEqual(orderA.status, 'new');

const postHoldBalance = store.getBalance(userId, 'usdt');
assert.ok(postHoldBalance.available < initialWallet.available, 'Hold should reduce available balance');

const cancelResult = store.cancelOrder(userId, orderA.id);
assert.strictEqual(cancelResult.status, 'cancelled', 'Cancel should mark order as cancelled');

const restoredBalance = store.getBalance(userId, 'usdt');
assert.strictEqual(restoredBalance.available.toString(), initialWallet.available.toString(), 'Cancel should restore held balance');

assert.throws(
  () =>
    store.createOrder({
      user_id: userId,
      symbol: 'xht-usdt',
      side: 'buy',
      size: '200',
      type: 'limit',
      price: '10',
    }),
  /insufficient|balance/i,
  'Orders without sufficient balance should be rejected'
);

assert.throws(
  () =>
    store.createOrder({
      user_id: userId,
      symbol: 'xht-usdt',
      side: 'buy',
      size: '1',
      type: 'market',
    }),
  /quote_cap/i,
  'Market buys must provide quote_cap'
);

const wallet = store.getWalletSummary(userId);
assert.ok(wallet.usdt_available, 'Wallet summary should expose available balance');

const trade = store.recordTrade({ symbol: 'xht-usdt', side: 'buy', price: 12, size: 1 });
assert.ok(trade.id, 'Trades should generate ids');

assert.strictEqual(toDisplay(toAtomic('1')), '1.00000000', 'Fixed point conversion should round-trip');

console.log('All deterministic backend tests passed');
