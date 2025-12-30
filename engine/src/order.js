const { DIRECTIONS } = require('./constants');

class SimpleOrder {
  constructor({ id, ouid, uuid, price, quantity, matchConstraint, orderType, direction, filledQuantity = 0 }) {
    this.id = id;
    this.ouid = ouid;
    this.uuid = uuid;
    this.price = price;
    this.quantity = quantity;
    this.matchConstraint = matchConstraint;
    this.orderType = orderType;
    this.direction = direction;
    this.filledQuantity = filledQuantity;
    this.better = null;
    this.worse = null;
    this.bucket = null;
  }

  remainedQuantity() {
    return this.quantity - this.filledQuantity;
  }

  isBid() {
    return this.direction === DIRECTIONS.BID;
  }
}

class Bucket {
  constructor(price) {
    this.price = price;
    this.totalQuantity = 0;
    this.ordersCount = 0;
    this.lastOrder = null;
  }
}

module.exports = {
  SimpleOrder,
  Bucket
};
