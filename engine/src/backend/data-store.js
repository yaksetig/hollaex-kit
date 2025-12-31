const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const config = require('./config');
const { toAtomic, toDisplay, multiplyAtomic } = require('./amounts');

class DataStore {
  constructor() {
    this.reset();
  }

  reset() {
    this.users = new Map();
    this.balances = new Map();
    this.orders = new Map();
    this.holds = new Map();
    this.holdsByRef = new Map();
    this.ledgerEntries = [];
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
    const total = BigInt(totalAtomic);
    const available = BigInt(availableAtomic);

    if (total < 0n || available < 0n) {
      throw new Error('Balance cannot be negative');
    }

    if (available > total) {
      throw new Error('Available balance cannot exceed total balance');
    }

    const key = `${userId}:${currency}`;
    this.balances.set(key, {
      user_id: String(userId),
      currency,
      total,
      available,
      updated_at: new Date().toISOString(),
    });
  }

  getBalance(userId, currency) {
    const key = `${userId}:${currency}`;
    return this.balances.get(key);
  }

  ensureBalance(userId, currency) {
    const existing = this.getBalance(userId, currency);
    if (existing) return existing;
    this.setBalance(userId, currency, 0n, 0n);
    return this.getBalance(userId, currency);
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

  updateBalance(userId, currency, { deltaTotal = 0n, deltaAvailable = 0n }) {
    const current = this.ensureBalance(userId, currency);
    const newTotal = BigInt(current.total) + BigInt(deltaTotal);
    const newAvailable = BigInt(current.available) + BigInt(deltaAvailable);

    this.setBalance(userId, currency, newTotal, newAvailable);
    return this.getBalance(userId, currency);
  }

  credit(userId, currency, amountAtomic) {
    const amount = BigInt(amountAtomic || 0);
    return this.updateBalance(userId, currency, { deltaTotal: amount, deltaAvailable: amount });
  }

  debit(userId, currency, amountAtomic) {
    const amount = BigInt(amountAtomic || 0);
    return this.updateBalance(userId, currency, { deltaTotal: -amount, deltaAvailable: -amount });
  }

  release(userId, currency, amountAtomic) {
    const amount = BigInt(amountAtomic || 0);
    return this.updateBalance(userId, currency, { deltaAvailable: amount });
  }

  createHold(userId, currency, amountAtomic, ref_type, ref_id) {
    const amount = BigInt(amountAtomic || 0);
    if (amount <= 0n) {
      throw new Error('Hold amount must be greater than zero');
    }

    const balance = this.updateBalance(userId, currency, { deltaAvailable: -amount });
    const hold = {
      id: uuidv4(),
      user_id: String(userId),
      currency,
      amount,
      remaining: amount,
      ref_type,
      ref_id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.holds.set(hold.id, hold);
    if (ref_type && ref_id) {
      this.holdsByRef.set(`${ref_type}:${ref_id}`, hold.id);
    }
    return { hold, balance };
  }

  releaseHold(holdId) {
    const hold = this.holds.get(holdId);
    if (!hold || hold.remaining <= 0n) return hold || null;

    this.updateBalance(hold.user_id, hold.currency, { deltaAvailable: hold.remaining });
    hold.remaining = 0n;
    hold.updated_at = new Date().toISOString();
    hold.released_at = hold.updated_at;
    return hold;
  }

  findHoldByReference(ref_type, ref_id) {
    const holdId = this.holdsByRef.get(`${ref_type}:${ref_id}`);
    return holdId ? this.holds.get(holdId) : null;
  }

  addLedgerEntry(entry) {
    this.ledgerEntries.push(entry);
  }

  createOrder(payload) {
    const { user_id, symbol, side, size, type, price, client_order_id, quote_cap } = payload;
    const idempotencyKey = client_order_id || `${user_id}:${symbol}:${side}:${type}:${price}:${size}:${quote_cap}`;

    if (this.idempotency.has(idempotencyKey)) {
      return this.orders.get(this.idempotency.get(idempotencyKey));
    }

    const market = config.markets.find((m) => m.symbol === symbol);
    if (!market) {
      throw new Error('Market not found');
    }

    const normalizedSide = side?.toLowerCase();
    const normalizedType = type?.toLowerCase();
    if (!['buy', 'sell'].includes(normalizedSide)) {
      throw new Error('Invalid side');
    }

    if (!['limit', 'market'].includes(normalizedType)) {
      throw new Error('Invalid order type');
    }

    if (size === undefined || size === null) {
      throw new Error('size is required');
    }

    const sizeDec = new Decimal(size);
    const incrementSize = new Decimal(market.increment_size || '0');
    if (!sizeDec.isPositive()) {
      throw new Error('Size must be greater than zero');
    }
    if (incrementSize.gt(0) && (sizeDec.lt(incrementSize) || !sizeDec.mod(incrementSize).eq(0))) {
      throw new Error('Size must align with market increment_size');
    }

    let priceAtomic = null;
    if (normalizedType === 'limit') {
      if (price === undefined || price === null) {
        throw new Error('price is required for limit orders');
      }
      const priceDec = new Decimal(price);
      const incrementPrice = new Decimal(market.increment_price || '0');
      if (!priceDec.isPositive()) {
        throw new Error('Price must be greater than zero');
      }
      if (incrementPrice.gt(0) && !priceDec.mod(incrementPrice).eq(0)) {
        throw new Error('Price must align with market increment_price');
      }
      priceAtomic = toAtomic(price);
    }

    let holdCurrency;
    let holdAmountAtomic;

    if (normalizedSide === 'buy') {
      holdCurrency = market.quote;
      if (normalizedType === 'market') {
        if (quote_cap === undefined || quote_cap === null) {
          throw new Error('quote_cap is required for market buy orders');
        }
        holdAmountAtomic = toAtomic(quote_cap);
      } else {
        holdAmountAtomic = multiplyAtomic(priceAtomic, sizeDec.toString());
      }
    } else {
      holdCurrency = market.base;
      holdAmountAtomic = toAtomic(sizeDec.toString());
    }

    const now = new Date().toISOString();
    const id = uuidv4();
    const fee = '0';

    const { hold } = this.createHold(user_id, holdCurrency, holdAmountAtomic, 'order', id);

    const order = {
      id,
      user_id: String(user_id),
      symbol,
      side: normalizedSide,
      type: normalizedType,
      price: price !== undefined && price !== null ? Number(price) : null,
      size: Number(size),
      quote_cap: quote_cap !== undefined && quote_cap !== null ? Number(quote_cap) : null,
      filled: 0,
      status: 'new',
      fee,
      fee_coin: symbol.split('-')[1],
      fee_structure: { maker: 0, taker: 0 },
      created_at: now,
      updated_at: now,
      client_order_id: client_order_id || null,
      hold_id: hold.id,
      hold_amount: hold.amount,
    };

    this.orders.set(id, order);
    this.idempotency.set(idempotencyKey, id);
    return order;
  }

  cancelOrder(userId, orderId) {
    const order = this.orders.get(orderId);
    if (!order || order.user_id !== String(userId)) return null;
    const now = new Date().toISOString();

    if (order.status === 'cancelled') {
      return order;
    }

    if (order.hold_id) {
      this.releaseHold(order.hold_id);
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
