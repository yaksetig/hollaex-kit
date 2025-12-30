const { SimpleOrder } = require('./order');

class PersistentOrder {
  constructor(order) {
    this.id = order.id;
    this.ouid = order.ouid;
    this.uuid = order.uuid;
    this.price = order.price;
    this.quantity = order.quantity;
    this.matchConstraint = order.matchConstraint;
    this.orderType = order.orderType;
    this.direction = order.direction;
    this.filledQuantity = order.filledQuantity;
  }

  toJSON() {
    return {
      id: this.id,
      ouid: this.ouid,
      uuid: this.uuid,
      price: this.price,
      quantity: this.quantity,
      matchConstraint: this.matchConstraint,
      orderType: this.orderType,
      direction: this.direction,
      filledQuantity: this.filledQuantity
    };
  }

  static fromJSON(json) {
    return new PersistentOrder(json);
  }
}

class PersistentOrderBook {
  constructor({ pair, lastOrder, tradeCounter, orders }) {
    this.pair = pair;
    this.lastOrder = lastOrder;
    this.tradeCounter = tradeCounter;
    this.orders = orders.map((order) => new PersistentOrder(order));
  }

  toJSON() {
    return {
      pair: this.pair,
      lastOrder: this.lastOrder,
      tradeCounter: this.tradeCounter,
      orders: this.orders.map((order) => order.toJSON())
    };
  }

  static fromJSON(json) {
    return new PersistentOrderBook({
      pair: json.pair,
      lastOrder: json.lastOrder,
      tradeCounter: json.tradeCounter,
      orders: (json.orders || []).map((order) => PersistentOrder.fromJSON(order))
    });
  }

  rebuildOrder(order) {
    return new SimpleOrder({
      id: order.id,
      ouid: order.ouid,
      uuid: order.uuid,
      price: order.price,
      quantity: order.quantity,
      matchConstraint: order.matchConstraint,
      orderType: order.orderType,
      direction: order.direction,
      filledQuantity: order.filledQuantity
    });
  }
}

module.exports = {
  PersistentOrder,
  PersistentOrderBook
};
