const express = require('express');
const { requireAuth, requirePermission, hasPermission, issueJwt } = require('./auth');
const config = require('./config');
const { Ledger } = require('./ledger');
const { toDisplay, toAtomic } = require('./amounts');
const { credentialStore } = require('./credential-store');

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

const buildRoutes = (store, hub, walletService) => {
  const router = express.Router();
  const ledger = new Ledger(store);

  const resolveSingleStatusAction = (flags = {}) => {
    const enabled = Object.entries(flags).filter(([, value]) => value);
    if (enabled.length > 1) {
      throw new Error('Can only update one parameter');
    }
    return enabled.length ? enabled[0][0] : null;
  };

  router.get('/network/init/:activation_code', (req, res) => {
    const activation = credentialStore.validateActivationCode(req.params.activation_code, config.exchange.id);
    if (!activation) {
      return res.status(404).json({ message: 'Unknown activation code' });
    }
    res.json({ ...store.exchange, activation_token: issueJwt(config.exchange.id, ['exchange:init']) });
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

  router.get('/network/:exchange_id/api-keys', requireAuth, (req, res) => {
    const { user_id } = req.query;
    const targetUser = user_id || req.auth.userId;
    if (targetUser !== req.auth.userId && !hasPermission(req.auth, 'manage_api_keys')) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const keys = credentialStore
      .listKeys(targetUser)
      .map(({ apiKey, permissions, createdAt, revokedAt }) => ({ api_key: apiKey, permissions, created_at: createdAt, revoked_at: revokedAt }));
    res.json({ count: keys.length, data: keys });
  });

  router.post('/network/:exchange_id/api-keys', requireAuth, (req, res) => {
    const { user_id, permissions } = req.body || {};
    const targetUser = user_id || req.auth.userId;
    if (targetUser !== req.auth.userId && !hasPermission(req.auth, 'manage_api_keys')) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const created = credentialStore.createApiKey({ userId: targetUser, permissions });
    res.status(201).json({
      api_key: created.apiKey,
      api_secret: created.secret,
      permissions: created.permissions,
      created_at: created.createdAt,
    });
  });

  router.delete('/network/:exchange_id/api-keys/:api_key', requireAuth, (req, res) => {
    const targetKey = credentialStore.getActiveKey(req.params.api_key);
    if (!targetKey) return res.status(404).json({ message: 'API key not found' });
    if (targetKey.userId !== req.auth.userId && !hasPermission(req.auth, 'manage_api_keys')) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const revoked = credentialStore.revokeKey(req.params.api_key);
    res.json({ api_key: revoked.apiKey, revoked_at: revoked.revokedAt });
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

  router.get('/network/:exchange_id/user', requireAuth, requirePermission('read'), (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ message: 'user_id is required' });
    const user = store.getUser(user_id);
    if (!user) return res.status(404).json({ message: 'user not found' });
    res.json(user);
  });

  router.get('/network/:exchange_id/users', requireAuth, requirePermission('read'), (req, res) => {
    const data = store.listUsers();
    res.json({ count: data.length, data });
  });

  router.post('/network/:exchange_id/signup', requireAuth, requirePermission('write'), (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: 'email is required' });
    const user = store.createUser(email);
    res.status(201).json(user);
  });

  router.get('/network/:exchange_id/balance', requireAuth, requirePermission('read'), (req, res) => {
    const { user_id } = req.query;
    const targetUser = user_id || req.auth.userId;

    if (!targetUser) return res.status(400).json({ message: 'user_id is required' });
    if (targetUser !== req.auth.userId && !hasPermission(req.auth, 'manage_api_keys')) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (user_id) {
      return res.json(store.getWalletSummary(targetUser));
    }

    const response = {};
    config.assets.forEach((asset) => {
      response[`${asset}_balance`] = toDisplay(store.getBalance(targetUser, asset)?.total || 0);
      response[`${asset}_available`] = toDisplay(store.getBalance(targetUser, asset)?.available || 0);
    });
    response.updated_at = new Date().toISOString();
    res.json(response);
  });

  router.get('/network/:exchange_id/balances', requireAuth, requirePermission('read'), (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ message: 'user_id is required' });
    res.json({ data: [store.getWalletSummary(user_id)], count: 1 });
  });

  router.get('/network/:exchange_id/orders', requireAuth, requirePermission('read'), (req, res) => {
    const { symbol, side, status, user_id, limit, page } = req.query;
    const result = store.listOrders({ symbol, side, status, user_id });
    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || result.data.length || 1;
    const start = (pageNum - 1) * limitNum;
    const data = result.data.slice(start, start + limitNum);
    res.json({ count: result.count, data, page: pageNum, limit: limitNum });
  });

  router.get('/network/:exchange_id/order', requireAuth, requirePermission('read'), (req, res) => {
    const { user_id, order_id } = req.query;
    if (!user_id || !order_id) return res.status(400).json({ message: 'user_id and order_id are required' });
    const order = store.getOrder(user_id, order_id);
    if (!order) return res.status(404).json({ message: 'order not found' });
    res.json(order);
  });

  router.post('/network/:exchange_id/order', requireAuth, requirePermission('trade'), (req, res) => {
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

  router.delete('/network/:exchange_id/order', requireAuth, requirePermission('trade'), (req, res) => {
    const { user_id, order_id } = req.query;
    if (!user_id || !order_id) return res.status(400).json({ message: 'user_id and order_id are required' });
    const order = store.cancelOrder(user_id, order_id);
    if (!order) return res.status(404).json({ message: 'order not found' });
    hub.publishOrder(user_id);
    hub.publishWallet(user_id);
    res.json(order);
  });

  router.delete('/network/:exchange_id/order/all', requireAuth, requirePermission('trade'), (req, res) => {
    const { user_id, symbol } = req.query;
    if (!user_id) return res.status(400).json({ message: 'user_id is required' });
    const data = store.cancelAll(user_id, symbol);
    hub.publishOrder(user_id);
    hub.publishWallet(user_id);
    res.json(data);
  });

  router.get('/network/:exchange_id/user/trades', requireAuth, requirePermission('read'), (req, res) => {
    const { user_id, symbol, side, limit, page } = req.query;
    const trades = store.listTrades({ symbol, side }).data.filter((t) => !user_id || t.user_id === String(user_id));
    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || trades.length || 1;
    const start = (pageNum - 1) * limitNum;
    const data = trades.slice(start, start + limitNum);
    res.json({ count: trades.length, data, page: pageNum, limit: limitNum });
  });

  router.post('/network/:exchange_id/mint', requireAuth, requirePermission('admin'), (req, res) => {
    const { user_id, currency, amount, status = true, transaction_id, description, address, fee } = req.body || {};
    if (!user_id || !currency || !amount) return res.status(400).json({ message: 'missing parameters' });

    try {
      if (status === false) {
        const pending = store.createPendingMint({ user_id, currency, amount, transaction_id, description, address, fee });
        return res.status(201).json(pending);
      }

      const entry = ledger.recordEntry({ user_id, currency, change: amount, reference: 'mint' });
      hub.publishWallet(user_id);
      res.status(201).json(entry);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  });

  router.put('/network/:exchange_id/mint', requireAuth, requirePermission('admin'), (req, res) => {
    const {
      transaction_id,
      status,
      dismissed,
      rejected,
      processing,
      waiting,
      onhold,
      updated_transaction_id,
      updated_address,
      updated_description,
    } = req.body || {};

    if (!transaction_id) return res.status(400).json({ message: 'transaction_id is required' });

    try {
      resolveSingleStatusAction({ status, dismissed, rejected, processing, waiting, onhold });
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }

    const mint = store.updatePendingMint(transaction_id, {
      id: updated_transaction_id || transaction_id,
      address: updated_address,
      description: updated_description,
    });

    if (!mint) return res.status(404).json({ message: 'pending mint not found' });

    if (status) {
      try {
        const entry = ledger.recordEntry({ user_id: mint.user_id, currency: mint.currency, change: mint.amount, reference: 'mint' });
        store.updatePendingMint(transaction_id, { status: 'confirmed' });
        hub.publishWallet(mint.user_id);
        return res.json(entry);
      } catch (error) {
        return res.status(400).json({ message: error.message });
      }
    }

    if (dismissed) store.updatePendingMint(transaction_id, { status: 'dismissed' });
    if (rejected) store.updatePendingMint(transaction_id, { status: 'rejected' });
    if (processing) store.updatePendingMint(transaction_id, { status: 'processing' });
    if (waiting) store.updatePendingMint(transaction_id, { status: 'waiting' });
    if (onhold) store.updatePendingMint(transaction_id, { status: 'onhold' });

    const updated = store.updatePendingMint(transaction_id, {});
    res.json(updated);
  });

  router.post('/network/:exchange_id/burn', requireAuth, requirePermission('admin'), (req, res) => {
    const { user_id, currency, amount, status = true, transaction_id, description, address, fee } = req.body || {};
    if (!user_id || !currency || !amount) return res.status(400).json({ message: 'missing parameters' });

    try {
      if (status === false) {
        const pending = store.createPendingBurn({ user_id, currency, amount, transaction_id, description, address, fee });
        return res.status(201).json(pending);
      }

      const entry = ledger.recordEntry({ user_id, currency, change: `-${amount}`, reference: 'burn' });
      hub.publishWallet(user_id);
      res.status(201).json(entry);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  });

  router.put('/network/:exchange_id/burn', requireAuth, requirePermission('admin'), (req, res) => {
    const {
      transaction_id,
      status,
      dismissed,
      rejected,
      processing,
      waiting,
      onhold,
      updated_transaction_id,
      updated_address,
      updated_description,
    } = req.body || {};

    if (!transaction_id) return res.status(400).json({ message: 'transaction_id is required' });

    try {
      resolveSingleStatusAction({ status, dismissed, rejected, processing, waiting, onhold });
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }

    const burn = store.updatePendingBurn(transaction_id, {
      id: updated_transaction_id || transaction_id,
      address: updated_address,
      description: updated_description,
    });

    if (!burn) return res.status(404).json({ message: 'pending burn not found' });

    if (status) {
      try {
        const entry = ledger.recordEntry({ user_id: burn.user_id, currency: burn.currency, change: `-${burn.amount}`, reference: 'burn' });
        store.updatePendingBurn(transaction_id, { status: 'confirmed' });
        hub.publishWallet(burn.user_id);
        return res.json(entry);
      } catch (error) {
        return res.status(400).json({ message: error.message });
      }
    }

    if (dismissed) store.updatePendingBurn(transaction_id, { status: 'dismissed' });
    if (rejected) store.updatePendingBurn(transaction_id, { status: 'rejected' });
    if (processing) store.updatePendingBurn(transaction_id, { status: 'processing' });
    if (waiting) store.updatePendingBurn(transaction_id, { status: 'waiting' });
    if (onhold) store.updatePendingBurn(transaction_id, { status: 'onhold' });

    const updated = store.updatePendingBurn(transaction_id, {});
    res.json(updated);
  });

  router.get('/network/:exchange_id/fees', requireAuth, requirePermission('read'), (req, res) => {
    res.json({ count: 0, data: [] });
  });

  router.get('/network/:exchange_id/fees/settle', requireAuth, requirePermission('admin'), (req, res) => {
    res.json({ settled: true, timestamp: new Date().toISOString() });
  });

  router.get('/network/:exchange_id/deposits', requireAuth, requirePermission('read'), (req, res) => {
    const result = store.listDeposits(req.query);
    res.json(result);
  });

  router.get('/network/:exchange_id/withdrawals', requireAuth, requirePermission('read'), (req, res) => {
    const result = store.listWithdrawals(req.query);
    res.json(result);
  });

  router.post('/network/:exchange_id/withdrawal', requireAuth, requirePermission('trade'), async (req, res) => {
    const { user_id, address, currency, amount, network } = { ...req.query, ...req.body };
    if (!user_id || !address || !currency || !amount) return res.status(400).json({ message: 'missing parameters' });

    try {
      const withdrawal = await walletService.requestWithdrawal({ userId: user_id, address, currency, amount, network });
      res.status(201).json(withdrawal);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  });

  router.delete('/network/:exchange_id/withdrawal', requireAuth, requirePermission('trade'), (req, res) => {
    const { user_id, withdrawal_id } = req.query;
    if (!user_id || !withdrawal_id) return res.status(400).json({ message: 'missing parameters' });
    const updated = store.cancelWithdrawal(user_id, withdrawal_id);
    if (!updated) return res.status(404).json({ message: 'withdrawal not found' });
    res.json(updated);
  });

  router.get('/network/:exchange_id/user/deposits', requireAuth, requirePermission('read'), (req, res) => {
    res.json(store.listDeposits(req.query));
  });

  router.get('/network/:exchange_id/user/withdrawals', requireAuth, requirePermission('read'), (req, res) => {
    res.json(store.listWithdrawals(req.query));
  });

  router.post('/network/:exchange_id/wallet/webhook', (req, res) => {
    const { type, data } = req.body || {};
    if (!type || !data) return res.status(400).json({ message: 'missing webhook payload' });

    if (type === 'deposit') {
      const deposit = walletService.recordIncomingDeposit(data);
      walletService.evaluateDepositProgress(deposit);
      return res.status(202).json(deposit);
    }

    if (type === 'withdrawal') {
      const withdrawal = store.updateWithdrawal(data.withdrawal_id, {
        tx_hash: data.tx_hash,
        confirmations: data.confirmations || 0,
        network: data.network,
      });
      if (!withdrawal) return res.status(404).json({ message: 'withdrawal not found' });
      walletService.evaluateWithdrawalProgress(withdrawal);
      return res.status(202).json(withdrawal);
    }

    return res.status(400).json({ message: 'unknown webhook type' });
  });

  router.post('/network/:exchange_id/wallet/poll', requireAuth, requirePermission('admin'), (req, res) => {
    const updated = walletService.pollConfirmations();
    res.json({ count: updated.length, data: updated });
  });

  router.get('/network/:exchange_id/trade', (req, res) => {
    res.json(store.listPublicTrades(req.query.symbol));
  });

  const handleCheckTransaction = (req, res) => {
    const { currency, transaction_id, address, network } = req.query;
    if (!currency || !transaction_id || !address || !network) {
      return res.status(400).json({ message: 'currency, transaction_id, address, and network are required' });
    }

    const deposit = store.findDepositByTx(transaction_id);
    const withdrawal = store.withdrawals.find(
      (item) => item.tx_hash === transaction_id || item.id === transaction_id
    );

    const match = [deposit, withdrawal].find(
      (tx) => tx && tx.currency === currency && tx.address === address && tx.network === network
    );

    if (!match) {
      return res.status(404).json({ message: 'transaction not found' });
    }

    res.json({
      currency: match.currency,
      transaction_id: transaction_id || match.id,
      address: match.address,
      network: match.network,
      confirmed: match.status === 'completed',
      confirmations: match.confirmations,
      confirmation_required: match.confirmation_required,
      reconciliation_state: match.reconciliation_state,
    });
  };

  router.get('/check-transaction', handleCheckTransaction);
  router.get('/network/:exchange_id/check-transaction', handleCheckTransaction);

  router.post('/network/:exchange_id/create-address', requireAuth, async (req, res) => {
    const { user_id, crypto, network } = { ...req.query, ...req.body };
    if (!user_id || !crypto) return res.status(400).json({ message: 'missing parameters' });

    try {
      const address = await walletService.createAddress({ userId: user_id, asset: crypto, network });
      res.status(201).json(address);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  });

  router.post('/network/:exchange_id/transfer', requireAuth, requirePermission('trade'), (req, res) => {
    const { sender_id, receiver_id, currency, amount } = req.body;
    if (!sender_id || !receiver_id || !currency || !amount) return res.status(400).json({ message: 'missing parameters' });

    const atomicAmount = toAtomic(amount);
    try {
      store.guardedDebit(sender_id, currency, atomicAmount);
      store.credit(receiver_id, currency, atomicAmount);
      hub.publishWallet(sender_id);
      hub.publishWallet(receiver_id);
      res.json({ status: 'completed' });
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  });

  router.get('/oracle/prices', (req, res) => {
    const { assets, quote = 'usdt', amount = 1 } = req.query;
    if (!assets) return res.status(400).json({ message: 'assets are required' });

    const assetList = String(assets)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    const amountNum = Number(amount) || 0;
    if (amountNum <= 0) return res.status(400).json({ message: 'amount must be greater than 0' });

    const prices = {};

    assetList.forEach((asset) => {
      if (asset === quote) {
        prices[asset] = amountNum;
        return;
      }

      const directPair = `${asset}-${quote}`;
      const inversePair = `${quote}-${asset}`;
      if (store.tickers[directPair]?.last) {
        prices[asset] = Number(store.tickers[directPair].last) * amountNum;
      } else if (store.tickers[inversePair]?.last) {
        prices[asset] = amountNum / Number(store.tickers[inversePair].last);
      } else {
        prices[asset] = 0;
      }
    });

    res.json(prices);
  });

  return router;
};

module.exports = { buildRoutes };
