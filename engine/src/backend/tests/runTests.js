const assert = require('assert');
const { DataStore } = require('../data-store');
const { toAtomic, toDisplay } = require('../amounts');

const store = new DataStore();

const userId = '42';
store.createUser('test@example.com');
store.setBalance(userId, 'usdt', toAtomic('1000'));
store.setBalance(userId, 'xht', toAtomic('50'));

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
assert.strictEqual(orderA.status, 'open');

const cancelResult = store.cancelOrder(userId, orderA.id);
assert.strictEqual(cancelResult.status, 'cancelled', 'Cancel should mark order as cancelled');

const wallet = store.getWalletSummary(userId);
assert.ok(wallet.usdt_available, 'Wallet summary should expose available balance');

const trade = store.recordTrade({ symbol: 'xht-usdt', side: 'buy', price: 12, size: 1 });
assert.ok(trade.id, 'Trades should generate ids');

assert.strictEqual(toDisplay(toAtomic('1')), '1.00000000', 'Fixed point conversion should round-trip');

console.log('All deterministic backend tests passed');
