const WebSocket = require('ws');
const config = require('./config');

const buildEnvelope = (payload) => ({ ...payload, time: Math.floor(Date.now() / 1000) });

class WebsocketHub {
  constructor(server, store) {
    this.server = new WebSocket.Server({ noServer: true });
    this.store = store;
    this.connections = new Set();

    server.on('upgrade', (request, socket, head) => {
      if (!request.url.startsWith('/stream')) return;
      this.server.handleUpgrade(request, socket, head, (ws) => {
        this.server.emit('connection', ws, request);
      });
    });

    this.server.on('connection', (ws, request) => {
      ws.subscriptions = new Set();
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));
      ws.on('message', (raw) => this.handleMessage(ws, raw.toString()));
      ws.on('close', () => this.connections.delete(ws));
      this.connections.add(ws);

      this.sendHeartbeat(ws);
    });

    this.heartbeat = setInterval(() => {
      this.server.clients.forEach((client) => {
        if (!client.isAlive) return client.terminate();
        client.isAlive = false;
        client.ping();
      });
    }, 15000);
  }

  close() {
    clearInterval(this.heartbeat);
    this.server.close();
  }

  handleMessage(ws, raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return;
    }

    const { op, args = [] } = parsed;
    if (op === 'subscribe') {
      args.forEach((topic) => ws.subscriptions.add(topic));
      this.publishSnapshots(ws, args);
    } else if (op === 'unsubscribe') {
      args.forEach((topic) => ws.subscriptions.delete(topic));
    }
  }

  send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(buildEnvelope(payload)));
    }
  }

  publishSnapshots(ws, topics) {
    topics.forEach((topic) => {
      if (topic.startsWith('orderbook')) {
        const [, symbol] = topic.split(':');
        const target = symbol ? { [symbol]: this.store.orderbooks[symbol] } : this.store.orderbooks;
        Object.entries(target).forEach(([sym, data]) => {
          this.send(ws, { topic: 'orderbook', action: 'partial', symbol: sym, data });
        });
      }
      if (topic.startsWith('trade')) {
        const [, symbol] = topic.split(':');
        const target = symbol ? { [symbol]: this.store.marketTrades[symbol] } : this.store.marketTrades;
        Object.entries(target).forEach(([sym, data]) => {
          this.send(ws, { topic: 'trade', action: 'partial', symbol: sym, data });
        });
      }
      if (topic.startsWith('order:')) {
        const userId = topic.split(':')[1];
        const { data } = this.store.listOrders({ user_id: userId });
        this.send(ws, { topic: 'order', action: 'partial', user_id: userId, data });
      }
      if (topic.startsWith('wallet:')) {
        const userId = topic.split(':')[1];
        const data = this.store.getWalletSummary(userId);
        this.send(ws, { topic: 'wallet', action: 'partial', user_id: userId, data });
      }
    });
  }

  broadcast(topicMatcher, payload) {
    this.connections.forEach((ws) => {
      const targets = Array.from(ws.subscriptions).filter(topicMatcher);
      if (targets.length) {
        this.send(ws, payload);
      }
    });
  }

  publishOrderbook(symbol) {
    const data = this.store.orderbooks[symbol];
    this.broadcast(
      (topic) => topic === 'orderbook' || topic === `orderbook:${symbol}`,
      { topic: 'orderbook', action: 'partial', symbol, data }
    );
  }

  publishTrades(symbol) {
    const data = this.store.marketTrades[symbol] || [];
    this.broadcast(
      (topic) => topic === 'trade' || topic === `trade:${symbol}` || topic === 'trades' || topic === `trades:${symbol}`,
      { topic: 'trade', action: 'partial', symbol, data }
    );
  }

  publishOrder(userId) {
    const { data } = this.store.listOrders({ user_id: userId });
    const payload = { topic: 'order', action: 'partial', user_id: userId, data };
    this.broadcast((topic) => topic === `order:${userId}` || topic === 'order', payload);
  }

  publishWallet(userId) {
    const data = this.store.getWalletSummary(userId);
    const payload = { topic: 'wallet', action: 'partial', user_id: userId, data };
    this.broadcast((topic) => topic === `wallet:${userId}` || topic === 'wallet', payload);
  }

  sendHeartbeat(ws) {
    this.send(ws, { topic: 'status', action: 'partial', data: { status: 'connected', exchange_id: config.exchange.id } });
  }
}

module.exports = { WebsocketHub };
