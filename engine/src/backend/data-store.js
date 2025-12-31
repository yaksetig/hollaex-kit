const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const { toAtomic, toDisplay, addAtomic, subtractAtomic, multiplyAtomic } = require('./amounts');

class DataStore {
  constructor() {
    this.reset();
  }

  reset() {
    this.users = new Map();
    this.balances = new Map();
    this.orders = new Map();
    this.trades = [];
    this.deposits = [];
    this.withdrawals = [];
    this.idempotency = new Map();

    this.exchange = {
      id: config.exchange.id,
      name: config.exchange.name,
      created_at: config.exchange.createdAt,
      assets: config.assets,
      pairs: config.markets.map((m) => m.symbol),
    };

    const seedUser = { id: '1', email: 'operator@demo.exchange', created_at: new Date().toISOString() };
    this.users.set(seedUser.id, seedUser);
    config.assets.forEach((asset) => {
      this.setBalance(seedUser.id, asset, toAtomic(asset === 'usdt' ? '10000' : '100'));
    });

    this.seedMarketData();
  }

  seedMarketData() {
    const now = new Date();
    this.tickers = {};
    this.orderbooks = {};
    this.marketTrades = {};

    config.markets.forEach((market, idx) => {
      const basePrice = 100 + idx * 50;
      this.tickers[market.symbol] = {
        last: basePrice,
        open: basePrice - 2,
        close: basePrice - 1,
        high: basePrice + 5,
        low: basePrice - 5,
        volume: 10 + idx,
        change: 0.01,
        timestamp: now.toISOString(),
      };

      this.orderbooks[market.symbol] = {
        bids: [
          [basePrice - 1, 1],
          [basePrice - 2, 2],
        ],
        asks: [
          [basePrice + 1, 1.5],
          [basePrice + 2, 2.5],
        ],
        timestamp: now.toISOString(),
      };

      this.marketTrades[market.symbol] = [
        {
          id: uuidv4(),
          price: basePrice,
          size: 0.5,
          side: 'buy',
          timestamp: now.toISOString(),
        },
      ];
    });
  }

  listUsers() {
    return Array.from(this.users.values());
  }

  getUser(id) {
    return this.users.get(String(id));
  }

  createUser(email) {
    const id = String(this.users.size + 1);
    const created_at = new Date().toISOString();
    const user = { id, email, created_at };
    this.users.set(id, user);
    config.assets.forEach((asset) => this.setBalance(id, asset, 0n));
    return user;
  }

  setBalance(userId, currency, totalAtomic, availableAtomic = totalAtomic) {
    const key = `${userId}:${currency}`;
    this.balances.set(key, {
      user_id: String(userId),
      currency,
      total: BigInt(totalAtomic),
      available: BigInt(availableAtomic),
      updated_at: new Date().toISOString(),
    });
  }

  getBalance(userId, currency) {
    const key = `${userId}:${currency}`;
    return this.balances.get(key);
  }

  getWalletSummary(userId) {
    const summary = {};
    config.assets.forEach((asset) => {
      const bal = this.getBalance(userId, asset) || {
        total: 0n,
        available: 0n,
        updated_at: new Date().toISOString(),
      };
      summary[`${asset}_balance`] = toDisplay(bal.total);
      summary[`${asset}_available`] = toDisplay(bal.available);
      summary.updated_at = bal.updated_at;
    });
    return summary;
  }

  credit(userId, currency, amountAtomic) {
    const current = this.getBalance(userId, currency) || {
      total: 0n,
      available: 0n,
      updated_at: new Date().toISOString(),
    };
    const total = addAtomic(current.total, amountAtomic);
    const available = addAtomic(current.available, amountAtomic);
    this.setBalance(userId, currency, total, available);
    return this.getBalance(userId, currency);
  }

  hold(userId, currency, amountAtomic) {
    const current = this.getBalance(userId, currency) || {
      total: 0n,
      available: 0n,
      updated_at: new Date().toISOString(),
    };
    const available = subtractAtomic(current.available, amountAtomic);
    this.setBalance(userId, currency, current.total, available);
    return this.getBalance(userId, currency);
  }

  release(userId, currency, amountAtomic) {
    const current = this.getBalance(userId, currency) || {
      total: 0n,
      available: 0n,
      updated_at: new Date().toISOString(),
    };
    const available = addAtomic(current.available, amountAtomic);
    this.setBalance(userId, currency, current.total, available);
    return this.getBalance(userId, currency);
  }

  createOrder(payload) {
    const { user_id, symbol, side, size, type, price, client_order_id } = payload;
    const idempotencyKey = client_order_id || `${user_id}:${symbol}:${side}:${type}:${price}:${size}`;

    if (this.idempotency.has(idempotencyKey)) {
      return this.orders.get(this.idempotency.get(idempotencyKey));
    }

    const now = new Date().toISOString();
    const id = uuidv4();
    const sizeAtomic = toAtomic(size);
    const priceAtomic = toAtomic(price);
    const fee = '0';

    const order = {
      id,
      user_id: String(user_id),
      symbol,
      side,
      type,
      price: price ? Number(price) : null,
      size: Number(size),
      filled: 0,
      status: 'open',
      fee,
      fee_coin: symbol.split('-')[1],
      fee_structure: { maker: 0, taker: 0 },
      created_at: now,
      updated_at: now,
      client_order_id: client_order_id || null,
    };

    const market = config.markets.find((m) => m.symbol === symbol);
    if (market) {
      if (side === 'buy') {
        const totalCost = multiplyAtomic(priceAtomic, size);
        this.hold(user_id, market.quote, totalCost);
      } else {
        this.hold(user_id, market.base, sizeAtomic);
      }
    }

    this.orders.set(id, order);
    this.idempotency.set(idempotencyKey, id);
    return order;
  }

  cancelOrder(userId, orderId) {
    const order = this.orders.get(orderId);
    if (!order) return null;
    const now = new Date().toISOString();

    if (order.status === 'cancelled') {
      return order;
    }

    const market = config.markets.find((m) => m.symbol === order.symbol);
    if (market) {
      if (order.side === 'buy') {
        const priceAtomic = toAtomic(order.price || 0);
        const sizeAtomic = toAtomic(order.size);
        const holdAmount = multiplyAtomic(priceAtomic, order.size);
        this.release(userId, market.quote, holdAmount);
      } else {
        const sizeAtomic = toAtomic(order.size);
        this.release(userId, market.base, sizeAtomic);
      }
    }

    const updated = { ...order, status: 'cancelled', updated_at: now };
    this.orders.set(orderId, updated);
    return updated;
  }

  cancelAll(userId, symbol) {
    const cancelled = [];
    this.orders.forEach((order, id) => {
      if (order.user_id === String(userId) && (!symbol || order.symbol === symbol)) {
        const result = this.cancelOrder(userId, id);
        if (result) cancelled.push(result);
      }
    });
    return cancelled;
  }

  listOrders(filters = {}) {
    const { symbol, side, status, user_id } = filters;
    let data = Array.from(this.orders.values());
    if (symbol) data = data.filter((o) => o.symbol === symbol);
    if (side) data = data.filter((o) => o.side === side);
    if (status) data = data.filter((o) => o.status === status);
    if (user_id) data = data.filter((o) => o.user_id === String(user_id));
    return { count: data.length, data };
  }

  getOrder(userId, orderId) {
    const order = this.orders.get(orderId);
    if (!order || order.user_id !== String(userId)) return null;
    return order;
  }

  recordTrade({ symbol, side, price, size }) {
    const trade = {
      id: uuidv4(),
      symbol,
      side,
      price: Number(price),
      size: Number(size),
      timestamp: new Date().toISOString(),
    };
    this.trades.push(trade);
    if (!this.marketTrades[symbol]) this.marketTrades[symbol] = [];
    this.marketTrades[symbol].push(trade);
    return trade;
  }

  listTrades(filters = {}) {
    const { symbol, side } = filters;
    let data = [...this.trades];
    if (symbol) data = data.filter((t) => t.symbol === symbol);
    if (side) data = data.filter((t) => t.side === side);
    return { count: data.length, data };
  }

  listPublicTrades(symbol) {
    const trades = symbol ? this.marketTrades[symbol] || [] : Object.values(this.marketTrades).flat();
    return trades;
  }

  addDeposit(payload) {
    const deposit = {
      id: uuidv4(),
      status: 'completed',
      created_at: new Date().toISOString(),
      ...payload,
    };
    this.deposits.push(deposit);
    return deposit;
  }

  addWithdrawal(payload) {
    const withdrawal = {
      id: uuidv4(),
      status: 'pending',
      created_at: new Date().toISOString(),
      ...payload,
    };
    this.withdrawals.push(withdrawal);
    return withdrawal;
  }

  listDeposits(filters = {}) {
    return this.applyFilters(this.deposits, filters);
  }

  listWithdrawals(filters = {}) {
    return this.applyFilters(this.withdrawals, filters);
  }

  updateWithdrawal(userId, withdrawalId, status) {
    const item = this.withdrawals.find((w) => w.id === withdrawalId && w.user_id === String(userId));
    if (!item) return null;
    item.status = status;
    item.updated_at = new Date().toISOString();
    return item;
  }

  applyFilters(collection, filters) {
    let data = [...collection];
    if (filters.user_id) data = data.filter((item) => item.user_id === String(filters.user_id));
    if (filters.currency) data = data.filter((item) => item.currency === filters.currency);
    if (filters.status) data = data.filter((item) => item.status === filters.status);
    const count = data.length;
    const page = Number(filters.page) || 1;
    const limit = Number(filters.limit) || count || 1;
    const start = (page - 1) * limit;
    const paginated = data.slice(start, start + limit);
    return { count, data: paginated, page, limit };
  }
}

module.exports = { DataStore };
