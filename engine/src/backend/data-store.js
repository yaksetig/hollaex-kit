const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const config = require('./config');
const { Database } = require('./db');
const { toAtomic, toDisplay, multiplyAtomic } = require('./amounts');
const { Ledger } = require('./ledger');

class DataStore {
  constructor(db) {
    this.db = db;
    this.reset();
  }

  async initialize() {
    if (this.db instanceof Database) {
      await this.loadFromDatabase();
    }
  }

  reset() {
    this.users = new Map();
    this.balances = new Map();
    this.orders = new Map();
    this.orderBooks = new Map();
    this.holds = new Map();
    this.holdsByRef = new Map();
    this.ledgerEntries = [];
    this.trades = [];
    this.deposits = [];
    this.withdrawals = [];
    this.addresses = [];
    this.pendingMints = [];
    this.pendingBurns = [];
    this.idempotency = new Map();
    this.ledger = new Ledger(this);

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

  createPendingMint(payload) {
    const mint = {
      id: payload.transaction_id || uuidv4(),
      user_id: String(payload.user_id),
      currency: payload.currency,
      amount: payload.amount,
      address: payload.address,
      description: payload.description,
      fee: payload.fee,
      status: 'pending',
      dismissed: false,
      rejected: false,
      processing: false,
      waiting: false,
      onhold: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    this.pendingMints.push(mint);
    return mint;
  }

  updatePendingMint(transactionId, patch = {}) {
    const mint = this.pendingMints.find((entry) => entry.id === transactionId || entry.previous_id === transactionId);
    if (!mint) return null;

    if (patch.id && patch.id !== mint.id) {
      mint.previous_id = mint.previous_id || mint.id;
    }

    Object.assign(mint, patch, { updated_at: new Date().toISOString() });
    return mint;
  }

  createPendingBurn(payload) {
    const burn = {
      id: payload.transaction_id || uuidv4(),
      user_id: String(payload.user_id),
      currency: payload.currency,
      amount: payload.amount,
      address: payload.address,
      description: payload.description,
      fee: payload.fee,
      status: 'pending',
      dismissed: false,
      rejected: false,
      processing: false,
      waiting: false,
      onhold: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    this.pendingBurns.push(burn);
    return burn;
  }

  updatePendingBurn(transactionId, patch = {}) {
    const burn = this.pendingBurns.find((entry) => entry.id === transactionId || entry.previous_id === transactionId);
    if (!burn) return null;

    if (patch.id && patch.id !== burn.id) {
      burn.previous_id = burn.previous_id || burn.id;
    }

    Object.assign(burn, patch, { updated_at: new Date().toISOString() });
    return burn;
  }

  async loadFromDatabase() {
    try {
      const users = await this.db.query('SELECT id, email, created_at FROM users ORDER BY id');
      this.users.clear();
      users.rows.forEach((row) => {
        const id = String(row.id);
        this.users.set(id, { id, email: row.email, created_at: row.created_at });
      });

      const balances = await this.db.query('SELECT user_id, currency, total, available, updated_at FROM balances');
      this.balances.clear();
      balances.rows.forEach((row) => {
        this.balances.set(`${row.user_id}:${row.currency}`, {
          user_id: String(row.user_id),
          currency: row.currency,
          total: toAtomic(row.total),
          available: toAtomic(row.available),
          updated_at: row.updated_at,
        });
      });

      const orders = await this.db.query('SELECT * FROM orders');
      this.orders.clear();
      orders.rows.forEach((row) => {
        const order = {
          ...row,
          id: row.id,
          user_id: String(row.user_id),
          price: row.price !== null ? Number(row.price) : null,
          size: Number(row.size),
          filled: Number(row.filled),
        };
        this.orders.set(order.id, order);
      });

      const trades = await this.db.query('SELECT * FROM trades ORDER BY timestamp');
      this.trades = trades.rows.map((row) => ({
        ...row,
        id: row.id,
        price: Number(row.price),
        size: Number(row.size),
        timestamp_ms: this.normalizeTimestampMs(row.timestamp),
      }));
      trades.rows.forEach((row) => {
        const symbol = row.symbol;
        if (!this.marketTrades[symbol]) this.marketTrades[symbol] = [];
        this.marketTrades[symbol].push({
          ...row,
          id: row.id,
          price: Number(row.price),
          size: Number(row.size),
          timestamp_ms: this.normalizeTimestampMs(row.timestamp),
        });
      });

      const deposits = await this.db.query('SELECT * FROM deposits');
      this.deposits = deposits.rows.map((row) => ({ ...row, user_id: row.user_id ? String(row.user_id) : null }));

      const withdrawals = await this.db.query('SELECT * FROM withdrawals');
      this.withdrawals = withdrawals.rows.map((row) => ({ ...row, user_id: row.user_id ? String(row.user_id) : null }));

      this.updateOrderbookSnapshotForAll();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load data from database, falling back to in-memory seed', error.message);
    }
  }

  seedMarketData() {
    const now = new Date();
    this.tickers = {};
    this.orderbooks = {};
    this.marketTrades = {};

    this.orderBooks.clear();

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

      this.marketTrades[market.symbol] = [];
      this.recordTrade({ symbol: market.symbol, side: 'buy', price: basePrice, size: 0.5, timestamp: now });

      this.orderBooks.set(market.symbol, { bids: [], asks: [] });
    });
  }

  normalizeTimestampMs(value, { defaultNow = false } = {}) {
    if (value === undefined || value === null || value === '') {
      if (defaultNow) return Date.now();
      throw new Error('Invalid timestamp');
    }

    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 1e12 ? Math.floor(numeric * 1000) : Math.floor(numeric);
    }

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }

    if (defaultNow) return Date.now();
    throw new Error('Invalid timestamp');
  }

  resolutionToMs(resolution) {
    const match = String(resolution || '')
      .trim()
      .match(/^(\d+)([mhdw]?)$/i);

    if (!match) return null;

    const value = Number(match[1]);
    const unit = match[2].toLowerCase();

    const unitMs =
      unit === 'h' ? 60 * 60 * 1000 : unit === 'd' ? 24 * 60 * 60 * 1000 : unit === 'w' ? 7 * 24 * 60 * 60 * 1000 : 60 * 1000;

    return value * unitMs;
  }

  extractTimestampMs(trade) {
    if (!trade) return Date.now();
    if (trade.timestamp_ms !== undefined) {
      return this.normalizeTimestampMs(trade.timestamp_ms, { defaultNow: true });
    }
    if (trade.timestamp) {
      const parsed = Date.parse(trade.timestamp);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Date.now();
  }

  isOpen(order) {
    return order && (order.status === 'new' || order.status === 'pfilled');
  }

  remainingSize(order) {
    return new Decimal(order.size).minus(new Decimal(order.filled || 0));
  }

  getMarket(symbol) {
    return config.markets.find((m) => m.symbol === symbol);
  }

  ensureBook(symbol) {
    if (!this.orderBooks.has(symbol)) {
      this.orderBooks.set(symbol, { bids: [], asks: [] });
    }
    return this.orderBooks.get(symbol);
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

    if (this.db) {
      this.db
        .query('INSERT INTO users (id, email, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [
          Number(id),
          email,
          created_at,
        ])
        .catch((error) => console.error('Failed to persist user', error.message));
    }
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

    if (this.db) {
      const totalDisplay = toDisplay(total);
      const availableDisplay = toDisplay(available);
      this.db
        .query(
          `INSERT INTO balances (user_id, currency, total, available, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (user_id, currency) DO UPDATE SET total = EXCLUDED.total, available = EXCLUDED.available, updated_at = NOW()`,
          [userId, currency, totalDisplay, availableDisplay]
        )
        .catch((error) => console.error('Failed to persist balance', error.message));
    }
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

  calculateLedgerBalance(currency) {
    let total = 0n;
    this.balances.forEach((bal) => {
      if (bal.currency === currency) {
        total += BigInt(bal.total);
      }
    });
    return total;
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

    const current = this.ensureBalance(userId, currency);
    if (BigInt(current.available) < amount) {
      const requested = toDisplay(amount);
      const available = toDisplay(current.available);
      throw new Error(
        `Insufficient available ${currency} balance to create hold: requested ${requested}, available ${available}`
      );
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

  consumeHold(holdId, amountAtomic) {
    const hold = this.holds.get(holdId);
    if (!hold || amountAtomic <= 0n) return hold || null;
    const consume = BigInt(amountAtomic);
    if (consume > hold.remaining) {
      throw new Error('Cannot consume more than remaining hold');
    }
    hold.remaining -= consume;
    hold.updated_at = new Date().toISOString();
    if (hold.remaining === 0n) {
      hold.released_at = hold.updated_at;
    }
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

    const market = this.getMarket(symbol);
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
    this.persistOrder(order);
    this.queueOrder(order);
    return this.orders.get(id);
  }

  persistOrder(order) {
    if (!this.db || !order) return;
    this.db
      .query(
        `INSERT INTO orders (id, user_id, symbol, side, type, price, size, filled, status, fee, fee_coin, fee_structure, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET filled = EXCLUDED.filled, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
        [
          order.id,
          Number(order.user_id),
          order.symbol,
          order.side,
          order.type,
          order.price,
          order.size,
          order.filled,
          order.status,
          order.fee,
          order.fee_coin,
          JSON.stringify(order.fee_structure),
          order.created_at,
          order.updated_at,
        ]
      )
      .catch((error) => console.error('Failed to persist order', error.message));
  }

  queueOrder(order) {
    const book = this.ensureBook(order.symbol);
    const side = order.side === 'buy' ? 'bids' : 'asks';

    if (order.type === 'market') {
      this.match(order);
      if (this.isOpen(order)) {
        order.status = 'cancelled';
        order.updated_at = new Date().toISOString();
        if (order.hold_id) {
          this.releaseHold(order.hold_id);
        }
      }
      this.updateOrderbookSnapshot(order.symbol);
      return;
    }

    book[side].push(order);
    this.sortBookSide(book[side], side);
    this.match(order);
    this.updateOrderbookSnapshot(order.symbol);
  }

  sortBookSide(list, side) {
    list.sort((a, b) => {
      if (side === 'bids') {
        if (a.price !== b.price) return b.price - a.price;
      } else if (a.price !== b.price) return a.price - b.price;
      return new Date(a.created_at) - new Date(b.created_at);
    });
  }

  pruneBooks(symbol) {
    const book = this.ensureBook(symbol);
    book.bids = book.bids.filter((order) => this.isOpen(order));
    book.asks = book.asks.filter((order) => this.isOpen(order));
    this.sortBookSide(book.bids, 'bids');
    this.sortBookSide(book.asks, 'asks');
  }

  match(taker) {
    const market = this.getMarket(taker.symbol);
    const book = this.ensureBook(taker.symbol);
    const takerSide = taker.side;
    const oppositeSide = takerSide === 'buy' ? 'asks' : 'bids';
    const priceComparator = taker.type === 'market'
      ? () => true
      : takerSide === 'buy'
        ? (maker) => maker.price <= taker.price
        : (maker) => maker.price >= taker.price;

    book[oppositeSide] = book[oppositeSide].filter((order) => this.isOpen(order));
    let bestMaker = book[oppositeSide][0];

    while (bestMaker && this.isOpen(taker) && this.isOpen(bestMaker) && priceComparator(bestMaker)) {
      const matchedQuantity = Decimal.min(this.remainingSize(taker), this.remainingSize(bestMaker));
      const price = bestMaker.price;

      this.applyTrade({ taker, maker: bestMaker, market, quantity: matchedQuantity, price });

      this.sortBookSide(book[oppositeSide], oppositeSide);
      this.sortBookSide(book[takerSide === 'buy' ? 'bids' : 'asks'], takerSide === 'buy' ? 'bids' : 'asks');
      bestMaker = book[oppositeSide].find((order) => this.isOpen(order));
      book[oppositeSide] = book[oppositeSide].filter((order) => this.isOpen(order));
    }

    if (!this.isOpen(taker)) {
      book[takerSide === 'buy' ? 'bids' : 'asks'] = book[takerSide === 'buy' ? 'bids' : 'asks'].filter((o) => this.isOpen(o));
    }
  }

  applyTrade({ taker, maker, market, quantity, price }) {
    const tradeSize = Number(quantity.toString());
    const baseAtomic = toAtomic(quantity.toString());
    const priceAtomic = toAtomic(price.toString());
    const quoteAtomic = multiplyAtomic(priceAtomic, quantity.toString());
    const timestamp = new Date().toISOString();

    taker.filled += tradeSize;
    maker.filled += tradeSize;

    taker.updated_at = timestamp;
    maker.updated_at = timestamp;

    taker.status = this.remainingSize(taker).eq(0) ? 'filled' : 'pfilled';
    maker.status = this.remainingSize(maker).eq(0) ? 'filled' : 'pfilled';

    const trade = this.recordTrade({
      symbol: market.symbol,
      side: taker.side,
      price,
      size: tradeSize,
      taker_order_id: taker.id,
      maker_order_id: maker.id,
    });

    this.settleBalanceForOrder(taker, market, baseAtomic, quoteAtomic, trade.id, price, tradeSize);
    this.settleBalanceForOrder(maker, market, baseAtomic, quoteAtomic, trade.id, price, tradeSize);

    if (taker.status === 'filled' && taker.hold_id) {
      this.releaseHold(taker.hold_id);
    }
    if (maker.status === 'filled' && maker.hold_id) {
      this.releaseHold(maker.hold_id);
    }

    this.orders.set(taker.id, { ...taker });
    this.orders.set(maker.id, { ...maker });
    this.persistOrder(taker);
    this.persistOrder(maker);
    this.updateOrderbookSnapshot(market.symbol);
  }

  settleBalanceForOrder(order, market, baseAtomic, quoteAtomic, tradeId, price, tradeSize) {
    const reference = `trade:${tradeId}`;
    const baseChange = toDisplay(baseAtomic);
    const quoteChange = toDisplay(quoteAtomic);
    if (order.side === 'buy') {
      this.consumeHold(order.hold_id, quoteAtomic);
      this.ledger.recordEntry({ user_id: order.user_id, currency: market.quote, change: `-${quoteChange}`, reference });
      this.ledger.recordEntry({ user_id: order.user_id, currency: market.base, change: baseChange, reference });
    } else {
      this.consumeHold(order.hold_id, baseAtomic);
      this.ledger.recordEntry({ user_id: order.user_id, currency: market.base, change: `-${baseChange}`, reference });
      this.ledger.recordEntry({ user_id: order.user_id, currency: market.quote, change: quoteChange, reference });
    }

    if (order.status === 'filled' && order.side === 'buy') {
      const remainingQuote = this.holds.get(order.hold_id)?.remaining || 0n;
      if (remainingQuote > 0n) {
        this.releaseHold(order.hold_id);
      }
    }

    const previousFilled = order.filled - tradeSize;
    const previousAvg = order.avg_price || 0;
    order.avg_price = previousFilled <= 0
      ? price
      : (previousAvg * previousFilled + price * tradeSize) / order.filled;
  }

  updateOrderbookSnapshot(symbol) {
    const book = this.ensureBook(symbol);
    const aggregate = (orders, side) => {
      const levels = new Map();
      orders
        .filter((order) => this.isOpen(order))
        .forEach((order) => {
          const remaining = this.remainingSize(order);
          if (remaining.lte(0)) return;
          if (order.price === null || order.price === undefined) return;
          const key = order.price;
          const existing = levels.get(key) || new Decimal(0);
          levels.set(key, existing.plus(remaining));
        });
      const sorted = Array.from(levels.entries()).sort((a, b) => {
        if (side === 'bids') return b[0] - a[0];
        return a[0] - b[0];
      });
      return sorted.map(([price, qty]) => [price, Number(qty.toFixed(Number(config.decimal.scale || 8)))]);
    };

    this.orderbooks[symbol] = {
      bids: aggregate(book.bids, 'bids'),
      asks: aggregate(book.asks, 'asks'),
      timestamp: new Date().toISOString(),
    };
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
    this.persistOrder(updated);
    this.pruneBooks(order.symbol);
    this.updateOrderbookSnapshot(order.symbol);
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

  recordTrade({ symbol, side, price, size, taker_order_id, maker_order_id, timestamp }) {
    const timestamp_ms = this.normalizeTimestampMs(timestamp ?? Date.now(), { defaultNow: true });
    const trade = {
      id: uuidv4(),
      symbol,
      side,
      price: Number(price),
      size: Number(size),
      taker_order_id,
      maker_order_id,
      timestamp: new Date(timestamp_ms).toISOString(),
      timestamp_ms,
    };
    this.trades.push(trade);
    if (!this.marketTrades[symbol]) this.marketTrades[symbol] = [];
    this.marketTrades[symbol].push(trade);

    if (this.db) {
      this.db
        .query(
          'INSERT INTO trades (id, symbol, side, price, size, timestamp) VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))',
          [trade.id, trade.symbol, trade.side, trade.price, trade.size, trade.timestamp_ms]
        )
        .catch((error) => console.error('Failed to persist trade', error.message));
    }
    return trade;
  }

  buildOhlcv({ symbol, from, to, resolution, fillGaps = true }) {
    if (!this.getMarket(symbol)) {
      throw new Error('Market not found');
    }

    const intervalMs = this.resolutionToMs(resolution);
    if (!intervalMs) {
      throw new Error('Unsupported resolution');
    }

    const fromMs = this.normalizeTimestampMs(from);
    const toMs = this.normalizeTimestampMs(to);

    if (fromMs >= toMs) {
      throw new Error('Invalid time range');
    }

    const trades = (this.marketTrades[symbol] || [])
      .filter((trade) => {
        const ts = this.extractTimestampMs(trade);
        return ts >= fromMs && ts <= toMs;
      })
      .sort((a, b) => this.extractTimestampMs(a) - this.extractTimestampMs(b));

    const buckets = new Map();
    trades.forEach((trade) => {
      const ts = this.extractTimestampMs(trade);
      const bucketTime = Math.floor(ts / intervalMs) * intervalMs;
      const existing = buckets.get(bucketTime);

      if (existing) {
        existing.high = Math.max(existing.high, trade.price);
        existing.low = Math.min(existing.low, trade.price);
        existing.close = trade.price;
        existing.volume += trade.size;
      } else {
        buckets.set(bucketTime, {
          time: bucketTime,
          open: trade.price,
          high: trade.price,
          low: trade.price,
          close: trade.price,
          volume: trade.size,
        });
      }
    });

    const candles = [];
    let cursor = Math.floor(fromMs / intervalMs) * intervalMs;
    if (cursor < fromMs) cursor += intervalMs;
    let previousClose = null;

    while (cursor <= toMs) {
      const bucket = buckets.get(cursor);
      if (bucket) {
        previousClose = bucket.close;
        candles.push(bucket);
      } else if (fillGaps && previousClose !== null) {
        // TradingView-friendly: fill gaps with the previous close to avoid missing bars
        candles.push({ time: cursor, open: previousClose, high: previousClose, low: previousClose, close: previousClose, volume: 0 });
      }
      cursor += intervalMs;
    }

    if (!candles.length) {
      return { s: 'no_data', nextTime: Math.floor(fromMs / 1000) };
    }

    return {
      s: 'ok',
      t: candles.map((candle) => Math.floor(candle.time / 1000)),
      o: candles.map((candle) => Number(candle.open)),
      h: candles.map((candle) => Number(candle.high)),
      l: candles.map((candle) => Number(candle.low)),
      c: candles.map((candle) => Number(candle.close)),
      v: candles.map((candle) => Number(candle.volume)),
    };
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

  saveAddress(record) {
    const existing = this.addresses.find(
      (address) =>
        address.user_id === record.user_id &&
        address.asset === record.asset &&
        address.network === record.network &&
        address.address === record.address
    );

    if (existing) return existing;

    this.addresses.push(record);
    return record;
  }

  createDepositTransaction(payload) {
    const deposit = {
      id: uuidv4(),
      status: 'pending',
      confirmations: 0,
      confirmation_required: 2,
      reconciliation_state: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...payload,
    };

    this.deposits.push(deposit);
    if (this.db) {
      this.db
        .query(
          'INSERT INTO deposits (id, user_id, currency, amount, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)',
          [deposit.id, deposit.user_id ? Number(deposit.user_id) : null, deposit.currency, deposit.amount, deposit.status, deposit.created_at]
        )
        .catch((error) => console.error('Failed to persist deposit', error.message));
    }
    return deposit;
  }

  updateDeposit(id, patch = {}) {
    const item = this.deposits.find((deposit) => deposit.id === id);
    if (!item) return null;

    Object.assign(item, patch, { updated_at: new Date().toISOString() });
    return item;
  }

  findDepositByTx(txHash) {
    return this.deposits.find((deposit) => deposit.tx_hash === txHash);
  }

  getPendingDeposits() {
    return this.deposits.filter(
      (deposit) =>
        !['completed', 'failed', 'cancelled'].includes(deposit.status) &&
        deposit.reconciliation_state !== 'pending_reconciliation'
    );
  }

  createWithdrawalTransaction(payload) {
    const withdrawal = {
      id: uuidv4(),
      status: 'pending',
      confirmations: 0,
      confirmation_required: 2,
      reconciliation_state: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...payload,
    };
    this.withdrawals.push(withdrawal);
    if (this.db) {
      this.db
        .query(
          'INSERT INTO withdrawals (id, user_id, currency, amount, address, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)',
          [withdrawal.id, withdrawal.user_id ? Number(withdrawal.user_id) : null, withdrawal.currency, withdrawal.amount, withdrawal.address, withdrawal.status, withdrawal.created_at]
        )
        .catch((error) => console.error('Failed to persist withdrawal', error.message));
    }
    return withdrawal;
  }

  createHoldForWithdrawal(withdrawalId, userId, currency, amountAtomic) {
    const { hold } = this.createHold(userId, currency, amountAtomic, 'withdrawal', withdrawalId);
    const withdrawal = this.withdrawals.find((item) => item.id === withdrawalId);
    if (withdrawal) {
      withdrawal.hold_id = hold.id;
      withdrawal.updated_at = new Date().toISOString();
    }
    return hold;
  }

  applyWithdrawalSettlement(withdrawalId, amountAtomic) {
    const withdrawal = this.withdrawals.find((item) => item.id === withdrawalId);
    if (!withdrawal) return null;

    if (withdrawal.hold_id) {
      this.consumeHold(withdrawal.hold_id, amountAtomic);
    }

    this.updateBalance(withdrawal.user_id, withdrawal.currency, { deltaTotal: -BigInt(amountAtomic), deltaAvailable: 0n });
    return this.getBalance(withdrawal.user_id, withdrawal.currency);
  }

  updateWithdrawal(withdrawalId, patch = {}) {
    const item = this.withdrawals.find((w) => w.id === withdrawalId);
    if (!item) return null;
    Object.assign(item, patch, { updated_at: new Date().toISOString() });
    return item;
  }

  cancelWithdrawal(userId, withdrawalId) {
    const item = this.withdrawals.find((w) => w.id === withdrawalId && w.user_id === String(userId));
    if (!item) return null;

    if (item.hold_id) {
      this.releaseHold(item.hold_id);
    }

    Object.assign(item, { status: 'cancelled', updated_at: new Date().toISOString() });
    return item;
  }

  getWithdrawal(withdrawalId) {
    return this.withdrawals.find((w) => w.id === withdrawalId) || null;
  }

  getPendingWithdrawals() {
    return this.withdrawals.filter(
      (withdrawal) =>
        !['completed', 'failed', 'cancelled'].includes(withdrawal.status) &&
        withdrawal.reconciliation_state !== 'pending_reconciliation'
    );
  }

  listDeposits(filters = {}) {
    return this.applyFilters(this.deposits, filters);
  }

  listWithdrawals(filters = {}) {
    return this.applyFilters(this.withdrawals, filters);
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
