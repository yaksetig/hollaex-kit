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
}

class PersistentOrderBook {
  constructor({ pair, lastOrder, tradeCounter, orders }) {
    this.pair = pair;
    this.lastOrder = lastOrder;
    this.tradeCounter = tradeCounter;
    this.orders = orders.map((order) => new PersistentOrder(order));
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
