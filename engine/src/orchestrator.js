const { SimpleOrderBook } = require('./orderBook');
const { EventDispatcher, OrderBookPublishedEvent, TradeEvent, CreateOrderEvent, UpdatedOrderEvent, CancelOrderEvent, RejectOrderEvent } = require('./events');
const { PersistentOrderBook } = require('./persistence');
const { SimpleOrder } = require('./order');

const noopAsync = async () => {};
const noop = () => {};

const defaultPersistence = {
  loadSnapshot: async () => null,
  saveSnapshot: noopAsync,
  loadOpenOrders: async () => [],
  persistTrade: noopAsync,
  persistOrder: noopAsync,
  persistOrderCancel: noopAsync,
  persistOrderReject: noopAsync
};

const defaultNetwork = {
  authenticate: async () => ({ mode: 'local-only' }),
  publishPublicEvent: noopAsync,
  publishPrivateEvent: noopAsync,
  publishHealth: noopAsync
};

const defaultAuth = {
  validateSession: () => true,
  validateSubscription: () => true,
  rateLimit: noop
};

class EngineOrchestrator {
  constructor({
    pair,
    persistence = {},
    network = {},
    auth = {},
    featureFlags = {}
  }) {
    this.pair = pair;
    this.persistence = { ...defaultPersistence, ...persistence };
    this.network = { ...defaultNetwork, ...network };
    this.auth = { ...defaultAuth, ...auth };
    this.featureFlags = featureFlags;

    this.dispatcher = new EventDispatcher();
    this.orderBook = new SimpleOrderBook(pair, this.dispatcher);

    this.dispatcher.on('*', (event) => this.handleEvent(event));
  }

  async init() {
    const snapshot = await this.persistence.loadSnapshot(this.pair);
    if (snapshot) {
      const persistent = snapshot instanceof PersistentOrderBook
        ? snapshot
        : PersistentOrderBook.fromJSON(snapshot);
      this.orderBook.rebuild(persistent);
    } else {
      await this.replayOpenOrders();
    }

    this.networkStatus = await this.network.authenticate();
    await this.network.publishHealth({ status: 'ready', pair: this.pair });
  }

  async replayOpenOrders() {
    const openOrders = await this.persistence.loadOpenOrders(this.pair);
    if (!openOrders || openOrders.length === 0) return;

    const persistent = new PersistentOrderBook({
      pair: this.pair,
      lastOrder: null,
      tradeCounter: 0,
      orders: openOrders.map((order) => ('toJSON' in order ? order.toJSON() : order))
    });

    this.orderBook.rebuild(persistent);
  }

  assertAuthenticated(session) {
    if (!this.auth.validateSession(session)) {
      const error = new Error('Unauthenticated session');
      error.code = 'UNAUTHENTICATED';
      throw error;
    }
  }

  async submitOrder(session, payload) {
    this.assertAuthenticated(session);
    this.auth.rateLimit(session, 'submitOrder');

    const order = this.orderBook.submitOrder(new SimpleOrder(payload));
    if (!order) return null;

    await this.persistence.persistOrder(order, { session, action: 'submit' });
    return order;
  }

  async cancelOrder(session, ouid) {
    this.assertAuthenticated(session);
    this.auth.rateLimit(session, 'cancelOrder');

    const order = this.orderBook.cancelOrder(ouid);
    if (!order) return null;

    await this.persistence.persistOrderCancel(order, { session, action: 'cancel' });
    return order;
  }

  async editOrder(session, ouid, updates) {
    this.assertAuthenticated(session);
    this.auth.rateLimit(session, 'editOrder');

    const order = this.orderBook.editOrder(ouid, updates);
    if (!order) return null;

    await this.persistence.persistOrder(order, { session, action: 'edit' });
    return order;
  }

  validateSubscription(session, topic) {
    this.assertAuthenticated(session);
    if (!this.auth.validateSubscription(session, topic)) {
      const error = new Error('Subscription not allowed');
      error.code = 'SUBSCRIPTION_REJECTED';
      throw error;
    }
  }

  async handleEvent(event) {
    if (event instanceof OrderBookPublishedEvent) {
      if (this.featureFlags.autoSnapshot !== false) {
        await this.persistence.saveSnapshot(event.orderBook.toJSON(), this.pair);
      }
      if (this.featureFlags.networkEnabled !== false) {
        await this.network.publishPublicEvent('orderbook', event.orderBook);
      }
      return;
    }

    if (event instanceof TradeEvent) {
      await this.persistence.persistTrade(event);
      if (this.featureFlags.networkEnabled !== false) {
        await this.network.publishPublicEvent('trade', event);
        await this.network.publishPrivateEvent(`order:${event.taker.uuid}`, event);
        await this.network.publishPrivateEvent(`order:${event.maker.uuid}`, event);
      }
      return;
    }

    if (event instanceof CreateOrderEvent || event instanceof UpdatedOrderEvent) {
      await this.persistence.persistOrder(event.order, { action: 'update' });
      return;
    }

    if (event instanceof CancelOrderEvent) {
      await this.persistence.persistOrderCancel(event.order, { action: 'cancel' });
      if (this.featureFlags.networkEnabled !== false) {
        await this.network.publishPrivateEvent(`order:${event.order.uuid}`, event);
      }
      return;
    }

    if (event instanceof RejectOrderEvent) {
      await this.persistence.persistOrderReject(event.payload, event.reason);
      return;
    }
  }
}

module.exports = { EngineOrchestrator };
