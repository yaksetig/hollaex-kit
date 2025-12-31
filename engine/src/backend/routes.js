const express = require('express');
const { requireAuth } = require('./auth');
const config = require('./config');
const { Ledger } = require('./ledger');
const { toDisplay, toAtomic } = require('./amounts');

const buildUdfConfig = () => ({
  supported_resolutions: ['1m', '5m', '1h', '1d'],
  supports_group_request: false,
  supports_marks: false,
  supports_search: true,
  supports_timescale_marks: false,
});

const buildUdfSymbol = (symbol) => ({
  name: symbol,
  ticker: symbol,
  description: symbol,
  type: 'spot',
  session: '24x7',
  exchange: config.exchange.name,
  listed_exchange: config.exchange.name,
  timezone: 'UTC',
  minmov: 1,
  pricescale: 100,
  supported_resolutions: ['1m', '5m', '1h', '1d'],
});

const buildRoutes = (store, hub) => {
  const router = express.Router();
  const ledger = new Ledger(store);

  router.get('/network/init/:activation_code', (req, res) => {
    if (req.params.activation_code !== config.exchange.activationCode) {
      return res.status(404).json({ message: 'Unknown activation code' });
    }
    res.json(store.exchange);
  });

  router.get('/network/:exchange_id/constants', (req, res) => {
    res.json({
      assets: config.assets,
      pairs: config.markets,
      exchange_id: config.exchange.id,
      exchange_name: config.exchange.name,
    });
  });

  router.get('/network/:exchange_id/exchange', (req, res) => {
    res.json({ ...store.exchange });
  });

  router.get('/network/:exchange_id/ticker', (req, res) => {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ message: 'symbol is required' });
    const ticker = store.tickers[symbol];
    if (!ticker) return res.status(404).json({ message: 'symbol not found' });
    res.json({ symbol, ...ticker });
  });

  router.get('/network/:exchange_id/tickers', (req, res) => {
    res.json(store.tickers);
  });

  router.get('/network/:exchange_id/orderbook', (req, res) => {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ message: 'symbol is required' });
    const data = store.orderbooks[symbol];
    if (!data) return res.status(404).json({ message: 'symbol not found' });
    res.json({ symbol, ...data });
  });

  router.get('/network/:exchange_id/orderbooks', (req, res) => {
    res.json(store.orderbooks);
  });

  router.get('/network/:exchange_id/trades', (req, res) => {
    const trades = store.listPublicTrades(req.query.symbol);
    res.json(trades);
  });

  router.get('/network/:exchange_id/trades/history', (req, res) => {
    const { symbol, side, limit, page } = req.query;
    const { count, data } = store.listTrades({ symbol, side });
    res.json({ count, data, page: Number(page) || 1, limit: Number(limit) || data.length });
  });

  router.get('/network/:exchange_id/chart', (req, res) => {
    const { from, to, symbol, resolution } = req.query;
    if (!from || !to || !symbol || !resolution) return res.status(400).json({ message: 'missing parameters' });
    try {
      const data = store.buildOhlcv({ symbol, from, to, resolution, fillGaps: true });
      res.json(data);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  });

  router.get('/network/:exchange_id/charts', (req, res) => {
    const { from, to, resolution } = req.query;
    if (!from || !to || !resolution) return res.status(400).json({ message: 'missing parameters' });
    try {
      const result = config.markets.map((market) => ({ symbol: market.symbol, ...store.buildOhlcv({ symbol: market.symbol, from, to, resolution, fillGaps: true }) }));
      res.json(result);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  });

  router.get('/network/:exchange_id/udf/config', (req, res) => res.json(buildUdfConfig()));

  router.get('/network/:exchange_id/udf/symbols', (req, res) => {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ message: 'symbol is required' });
    res.json(buildUdfSymbol(symbol));
  });

  router.get('/network/:exchange_id/udf/history', (req, res) => {
    const { from, to, symbol, resolution } = req.query;
    if (!from || !to || !symbol || !resolution) return res.status(400).json({ message: 'missing parameters' });
    try {
      const data = store.buildOhlcv({ symbol, from, to, resolution, fillGaps: true });
      res.json(data);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  });

  router.get('/network/:exchange_id/user', requireAuth, (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ message: 'user_id is required' });
    const user = store.getUser(user_id);
    if (!user) return res.status(404).json({ message: 'user not found' });
    res.json(user);
  });

  router.get('/network/:exchange_id/users', requireAuth, (req, res) => {
    const data = store.listUsers();
    res.json({ count: data.length, data });
  });

  router.post('/network/:exchange_id/signup', requireAuth, (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: 'email is required' });
    const user = store.createUser(email);
    res.status(201).json(user);
  });

  router.get('/network/:exchange_id/balance', requireAuth, (req, res) => {
    const { user_id } = req.query;
    if (user_id) {
      return res.json(store.getWalletSummary(user_id));
    }
    const response = {};
    config.assets.forEach((asset) => {
      response[`${asset}_balance`] = toDisplay(store.getBalance('1', asset)?.total || 0);
      response[`${asset}_available`] = toDisplay(store.getBalance('1', asset)?.available || 0);
    });
    response.updated_at = new Date().toISOString();
    res.json(response);
  });

  router.get('/network/:exchange_id/balances', requireAuth, (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ message: 'user_id is required' });
    res.json({ data: [store.getWalletSummary(user_id)], count: 1 });
  });

  router.get('/network/:exchange_id/orders', requireAuth, (req, res) => {
    const { symbol, side, status, user_id, limit, page } = req.query;
    const result = store.listOrders({ symbol, side, status, user_id });
    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || result.data.length || 1;
    const start = (pageNum - 1) * limitNum;
    const data = result.data.slice(start, start + limitNum);
    res.json({ count: result.count, data, page: pageNum, limit: limitNum });
  });

  router.get('/network/:exchange_id/order', requireAuth, (req, res) => {
    const { user_id, order_id } = req.query;
    if (!user_id || !order_id) return res.status(400).json({ message: 'user_id and order_id are required' });
    const order = store.getOrder(user_id, order_id);
    if (!order) return res.status(404).json({ message: 'order not found' });
    res.json(order);
  });

  router.post('/network/:exchange_id/order', requireAuth, (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ message: 'user_id is required' });
    try {
      const order = store.createOrder({ user_id, ...req.body });
      hub.publishOrder(user_id);
      hub.publishWallet(user_id);
      res.status(201).json(order);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  });

  router.delete('/network/:exchange_id/order', requireAuth, (req, res) => {
    const { user_id, order_id } = req.query;
    if (!user_id || !order_id) return res.status(400).json({ message: 'user_id and order_id are required' });
    const order = store.cancelOrder(user_id, order_id);
    if (!order) return res.status(404).json({ message: 'order not found' });
    hub.publishOrder(user_id);
    hub.publishWallet(user_id);
    res.json(order);
  });

  router.delete('/network/:exchange_id/order/all', requireAuth, (req, res) => {
    const { user_id, symbol } = req.query;
    if (!user_id) return res.status(400).json({ message: 'user_id is required' });
    const data = store.cancelAll(user_id, symbol);
    hub.publishOrder(user_id);
    hub.publishWallet(user_id);
    res.json(data);
  });

  router.get('/network/:exchange_id/user/trades', requireAuth, (req, res) => {
    const { user_id, symbol, side, limit, page } = req.query;
    const trades = store.listTrades({ symbol, side }).data.filter((t) => !user_id || t.user_id === String(user_id));
    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || trades.length || 1;
    const start = (pageNum - 1) * limitNum;
    const data = trades.slice(start, start + limitNum);
    res.json({ count: trades.length, data, page: pageNum, limit: limitNum });
  });

  router.post('/network/:exchange_id/mint', requireAuth, (req, res) => {
    const { user_id, currency, amount } = req.body;
    if (!user_id || !currency || !amount) return res.status(400).json({ message: 'missing parameters' });
    try {
      const entry = ledger.recordEntry({ user_id, currency, change: amount, reference: 'mint' });
      hub.publishWallet(user_id);
      res.status(201).json(entry);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  });

  router.post('/network/:exchange_id/burn', requireAuth, (req, res) => {
    const { user_id, currency, amount } = req.body;
    if (!user_id || !currency || !amount) return res.status(400).json({ message: 'missing parameters' });
    try {
      const entry = ledger.recordEntry({ user_id, currency, change: `-${amount}`, reference: 'burn' });
      hub.publishWallet(user_id);
      res.status(201).json(entry);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  });

  router.get('/network/:exchange_id/fees', requireAuth, (req, res) => {
    res.json({ count: 0, data: [] });
  });

  router.get('/network/:exchange_id/fees/settle', requireAuth, (req, res) => {
    res.json({ settled: true, timestamp: new Date().toISOString() });
  });

  router.get('/network/:exchange_id/deposits', requireAuth, (req, res) => {
    const result = store.listDeposits(req.query);
    res.json(result);
  });

  router.get('/network/:exchange_id/withdrawals', requireAuth, (req, res) => {
    const result = store.listWithdrawals(req.query);
    res.json(result);
  });

  router.post('/network/:exchange_id/withdrawal', requireAuth, (req, res) => {
    const { user_id, address, currency, amount } = req.query;
    if (!user_id || !address || !currency || !amount) return res.status(400).json({ message: 'missing parameters' });
    const withdrawal = store.addWithdrawal({ user_id: String(user_id), address, currency, amount });
    res.status(201).json(withdrawal);
  });

  router.delete('/network/:exchange_id/withdrawal', requireAuth, (req, res) => {
    const { user_id, withdrawal_id } = req.query;
    if (!user_id || !withdrawal_id) return res.status(400).json({ message: 'missing parameters' });
    const updated = store.updateWithdrawal(user_id, withdrawal_id, 'cancelled');
    if (!updated) return res.status(404).json({ message: 'withdrawal not found' });
    res.json(updated);
  });

  router.get('/network/:exchange_id/user/deposits', requireAuth, (req, res) => {
    res.json(store.listDeposits(req.query));
  });

  router.get('/network/:exchange_id/user/withdrawals', requireAuth, (req, res) => {
    res.json(store.listWithdrawals(req.query));
  });

  router.get('/network/:exchange_id/trade', (req, res) => {
    res.json(store.listPublicTrades(req.query.symbol));
  });

  router.get('/check-transaction', (req, res) => {
    res.json({
      currency: req.query.currency,
      transaction_id: req.query.transaction_id,
      address: req.query.address,
      network: req.query.network,
      confirmed: true,
      is_testnet: req.query.isTestnet === 'true',
    });
  });

  router.post('/network/:exchange_id/create-address', requireAuth, (req, res) => {
    const { user_id, crypto, network } = req.query;
    if (!user_id || !crypto) return res.status(400).json({ message: 'missing parameters' });
    res.status(201).json({
      user_id: String(user_id),
      crypto,
      network: network || 'mainnet',
      address: `demo-${crypto}-address-${user_id}`,
      created_at: new Date().toISOString(),
    });
  });

  router.post('/network/:exchange_id/transfer', requireAuth, (req, res) => {
    const { sender_id, receiver_id, currency, amount } = req.body;
    if (!sender_id || !receiver_id || !currency || !amount) return res.status(400).json({ message: 'missing parameters' });

    const atomicAmount = toAtomic(amount);
    try {
      store.debit(sender_id, currency, atomicAmount);
      store.credit(receiver_id, currency, atomicAmount);
      hub.publishWallet(sender_id);
      hub.publishWallet(receiver_id);
      res.json({ status: 'completed' });
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  });

  return router;
};

module.exports = { buildRoutes };
