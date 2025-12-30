const {
  MATCH_CONSTRAINTS,
  ORDER_TYPES,
  DIRECTIONS,
  REJECTION_REASONS
} = require('./constants');
const {
  CreateOrderEvent,
  UpdatedOrderEvent,
  CancelOrderEvent,
  TradeEvent,
  RejectOrderEvent,
  OrderBookPublishedEvent,
  EventDispatcher
} = require('./events');
const { SimpleOrder, Bucket } = require('./order');
const { PersistentOrderBook } = require('./persistence');

const unsupportedConstraints = new Set([
  MATCH_CONSTRAINTS.FOK,
  MATCH_CONSTRAINTS.FOK_BUDGET,
  MATCH_CONSTRAINTS.IOC_BUDGET
]);

class SimpleOrderBook {
  constructor(pair, dispatcher = new EventDispatcher()) {
    this.pair = pair;
    this.dispatcher = dispatcher;
    this.askBuckets = new Map();
    this.bidBuckets = new Map();
    this.orders = new Map();
    this.ordersByOuid = new Map();
    this.bestAskOrder = null;
    this.bestBidOrder = null;
    this.lastOrder = null;
    this.orderCounter = 0;
    this.tradeCounter = 0;
    this.replayMode = false;
  }

  startReplayMode() {
    this.replayMode = true;
  }

  stopReplayMode() {
    this.replayMode = false;
  }

  submitOrder(orderInput) {
    const { matchConstraint } = orderInput;
    if (unsupportedConstraints.has(matchConstraint)) {
      this.dispatchReject(orderInput, REJECTION_REASONS.OPERATION_NOT_MATCHED_MATCHC);
      return null;
    }

    if (matchConstraint === MATCH_CONSTRAINTS.GTC && orderInput.orderType === ORDER_TYPES.MARKET_ORDER) {
      this.dispatchReject(orderInput, REJECTION_REASONS.ORDER_TYPE_NOT_MATCHED_MATCHC);
      return null;
    }

    const order = this.allocateOrder(orderInput);
    this.dispatch(new CreateOrderEvent({ order }));

    if (matchConstraint === MATCH_CONSTRAINTS.GTC) {
      this.matchInstantly(order);
      if (order.remainedQuantity() > 0) {
        this.putGtcInQueue(order);
      }
    } else if (matchConstraint === MATCH_CONSTRAINTS.IOC) {
      this.matchIocInstantly(order);
      if (order.remainedQuantity() > 0) {
        this.dispatch(new CancelOrderEvent({ order }));
      }
    }

    this.lastOrder = order;
    this.publishOrderBook();
    return order;
  }

  cancelOrder(ouid) {
    const existingOrder = this.ordersByOuid.get(ouid);
    if (!existingOrder) {
      this.dispatchReject({ ouid }, REJECTION_REASONS.ORDER_NOT_FOUND);
      return null;
    }

    this.detachOrder(existingOrder);
    this.dispatch(new CancelOrderEvent({ order: existingOrder }));
    this.lastOrder = existingOrder;
    this.publishOrderBook();
    return existingOrder;
  }

  editOrder(ouid, updates) {
    const existingOrder = this.ordersByOuid.get(ouid);
    if (!existingOrder) {
      this.dispatchReject({ ouid }, REJECTION_REASONS.ORDER_NOT_FOUND);
      return null;
    }

    this.detachOrder(existingOrder);

    const updatedOrder = new SimpleOrder({
      id: existingOrder.id,
      ouid: existingOrder.ouid,
      uuid: existingOrder.uuid,
      filledQuantity: existingOrder.filledQuantity,
      price: updates.price !== undefined ? updates.price : existingOrder.price,
      quantity: updates.quantity !== undefined ? updates.quantity : existingOrder.quantity,
      matchConstraint: updates.matchConstraint || existingOrder.matchConstraint,
      orderType: updates.orderType || existingOrder.orderType,
      direction: updates.direction || existingOrder.direction
    });

    this.dispatch(new UpdatedOrderEvent({ order: updatedOrder }));

    if (updatedOrder.matchConstraint === MATCH_CONSTRAINTS.GTC) {
      this.matchInstantly(updatedOrder);
      if (updatedOrder.remainedQuantity() > 0) {
        this.putGtcInQueue(updatedOrder);
      }
    } else if (updatedOrder.matchConstraint === MATCH_CONSTRAINTS.IOC) {
      this.matchIocInstantly(updatedOrder);
      if (updatedOrder.remainedQuantity() > 0) {
        this.dispatch(new CancelOrderEvent({ order: updatedOrder }));
      }
    } else if (unsupportedConstraints.has(updatedOrder.matchConstraint)) {
      this.dispatchReject(updatedOrder, REJECTION_REASONS.OPERATION_NOT_MATCHED_MATCHC);
    }

    this.orderCounter = Math.max(this.orderCounter, updatedOrder.id || 0);
    this.lastOrder = updatedOrder;
    this.publishOrderBook();
    return updatedOrder;
  }

  matchInstantly(order) {
    const bestMaker = order.isBid() ? () => this.bestAskOrder : () => this.bestBidOrder;
    const pricePredicate = (maker) => {
      if (order.orderType === ORDER_TYPES.MARKET_ORDER) return true;
      if (order.isBid()) {
        return maker.price <= order.price;
      }
      return maker.price >= order.price;
    };

    this.matchOrders(order, bestMaker, pricePredicate);
  }

  matchIocInstantly(order) {
    const bestMaker = order.isBid() ? () => this.bestAskOrder : () => this.bestBidOrder;
    const pricePredicate = (maker) => {
      if (order.orderType === ORDER_TYPES.MARKET_ORDER) return true;
      if (order.isBid()) {
        return maker.price <= order.price;
      }
      return maker.price >= order.price;
    };

    this.matchOrders(order, bestMaker, pricePredicate);
  }

  matchOrders(taker, bestMakerSelector, pricePredicate) {
    let maker = bestMakerSelector();
    if (!maker || !pricePredicate(maker)) return;

    while (maker && pricePredicate(maker) && taker.remainedQuantity() > 0) {
      const matchedQuantity = Math.min(taker.remainedQuantity(), maker.remainedQuantity());
      taker.filledQuantity += matchedQuantity;
      maker.filledQuantity += matchedQuantity;
      maker.bucket.totalQuantity -= matchedQuantity;

      this.tradeCounter += 1;
      this.dispatch(new TradeEvent({
        tradeId: this.tradeCounter,
        pair: this.pair,
        taker,
        maker,
        matchedQuantity,
        price: maker.price
      }));

      if (maker.remainedQuantity() === 0) {
        const nextMaker = maker.worse;
        this.removeOrderFromBook(maker);
        maker = nextMaker;
      } else {
        break;
      }
    }
  }

  putGtcInQueue(order) {
    const bucketMap = order.isBid() ? this.bidBuckets : this.askBuckets;
    let bucket = bucketMap.get(order.price);

    if (!bucket) {
      bucket = new Bucket(order.price);
      bucketMap.set(order.price, bucket);
      this.linkBucketOrder(order, bucket);
    } else {
      this.appendToBucket(order, bucket);
    }

    this.orders.set(order.id, order);
    this.ordersByOuid.set(order.ouid, order);
  }

  linkBucketOrder(order, bucket) {
    order.bucket = bucket;
    bucket.ordersCount = 1;
    bucket.totalQuantity = order.remainedQuantity();
    bucket.lastOrder = order;

    const betterBucket = this.findBetterBucket(order.direction, order.price);

    if (betterBucket && betterBucket.lastOrder) {
      const worseNeighbor = betterBucket.lastOrder.worse;
      order.better = betterBucket.lastOrder;
      order.worse = worseNeighbor;
      betterBucket.lastOrder.worse = order;
      if (worseNeighbor) {
        worseNeighbor.better = order;
      }
    } else {
      const currentBest = order.isBid() ? this.bestBidOrder : this.bestAskOrder;
      order.better = null;
      order.worse = currentBest;
      if (currentBest) {
        currentBest.better = order;
      }
    }

    if (order.isBid()) {
      if (!this.bestBidOrder || order.price > this.bestBidOrder.price) {
        this.bestBidOrder = order;
      }
    } else if (!this.bestAskOrder || order.price < this.bestAskOrder.price) {
      this.bestAskOrder = order;
    }
  }

  appendToBucket(order, bucket) {
    order.bucket = bucket;
    order.better = bucket.lastOrder;
    order.worse = bucket.lastOrder ? bucket.lastOrder.worse : null;

    if (bucket.lastOrder) {
      const previousTail = bucket.lastOrder;
      const previousWorse = previousTail.worse;
      previousTail.worse = order;
      if (previousWorse) {
        previousWorse.better = order;
      }
    }

    bucket.lastOrder = order;
    bucket.ordersCount += 1;
    bucket.totalQuantity += order.remainedQuantity();
  }

  removeOrderFromBook(order) {
    this.orders.delete(order.id);
    this.ordersByOuid.delete(order.ouid);
    const bucket = order.bucket;
    if (!bucket) return;

    bucket.ordersCount -= 1;
    bucket.totalQuantity -= order.remainedQuantity();

    const { better, worse } = order;
    if (better) better.worse = worse;
    if (worse) worse.better = better;

    if (bucket.lastOrder === order) {
      if (bucket.ordersCount === 0) {
        const bucketMap = order.isBid() ? this.bidBuckets : this.askBuckets;
        bucketMap.delete(bucket.price);
      } else {
        bucket.lastOrder = better;
      }
    }

    if (order === this.bestBidOrder) {
      this.bestBidOrder = worse;
      if (this.bestBidOrder && this.bestBidOrder.isBid()) {
        this.bestBidOrder.better = null;
      }
    }

    if (order === this.bestAskOrder) {
      this.bestAskOrder = worse;
      if (this.bestAskOrder && !this.bestAskOrder.isBid()) {
        this.bestAskOrder.better = null;
      }
    }

    order.better = null;
    order.worse = null;
    order.bucket = null;
  }

  detachOrder(order) {
    this.removeOrderFromBook(order);
  }

  findBetterBucket(direction, price) {
    const bucketMap = direction === DIRECTIONS.BID ? this.bidBuckets : this.askBuckets;
    let candidate = null;
    for (const bucket of bucketMap.values()) {
      if (direction === DIRECTIONS.BID) {
        if (bucket.price > price && (!candidate || bucket.price < candidate.price)) {
          candidate = bucket;
        }
      } else if (bucket.price < price && (!candidate || bucket.price > candidate.price)) {
        candidate = bucket;
      }
    }
    return candidate;
  }

  allocateOrder(payload) {
    const id = payload.id || ++this.orderCounter;
    return new SimpleOrder({ ...payload, id });
  }

  dispatchReject(payload, reason) {
    this.dispatch(new RejectOrderEvent({ payload, reason }));
  }

  dispatch(event) {
    if (!this.replayMode) {
      this.dispatcher.dispatch(event);
    }
  }

  publishOrderBook() {
    const persistent = this.persistent();
    this.dispatch(new OrderBookPublishedEvent({ orderBook: persistent }));
  }

  persistent() {
    const openOrders = Array.from(this.orders.values());
    return new PersistentOrderBook({
      pair: this.pair,
      lastOrder: this.lastOrder ? { id: this.lastOrder.id, ouid: this.lastOrder.ouid } : null,
      tradeCounter: this.tradeCounter,
      orders: openOrders
    });
  }

  rebuild(persistentOrderBook) {
    this.startReplayMode();
    this.askBuckets.clear();
    this.bidBuckets.clear();
    this.orders.clear();
    this.ordersByOuid.clear();
    this.bestAskOrder = null;
    this.bestBidOrder = null;
    this.tradeCounter = persistentOrderBook.tradeCounter || 0;

    persistentOrderBook.orders
      .map((order) => persistentOrderBook.rebuildOrder(order))
      .forEach((order) => {
        this.orderCounter = Math.max(this.orderCounter, order.id);
        this.matchInstantly(order);
        if (order.remainedQuantity() > 0) {
          this.putGtcInQueue(order);
        }
      });

    this.lastOrder = persistentOrderBook.lastOrder
      ? this.orders.get(persistentOrderBook.lastOrder.id) || null
      : null;

    this.stopReplayMode();
    this.publishOrderBook();
  }

  rebuildFromJSON(json) {
    const persistent = this.persistent().constructor.fromJSON(json);
    this.rebuild(persistent);
  }
}

module.exports = {
  SimpleOrderBook
};
