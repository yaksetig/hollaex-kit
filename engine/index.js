const {
  MATCH_CONSTRAINTS,
  ORDER_TYPES,
  DIRECTIONS,
  REJECTION_REASONS
} = require('./src/constants');
const { EventDispatcher, CreateOrderEvent, UpdatedOrderEvent, CancelOrderEvent, TradeEvent, RejectOrderEvent, OrderBookPublishedEvent } = require('./src/events');
const { SimpleOrder, Bucket } = require('./src/order');
const { SimpleOrderBook } = require('./src/orderBook');
const { PersistentOrder, PersistentOrderBook } = require('./src/persistence');
const EngineGateway = require('./src/gateway');

module.exports = {
  // constants
  MATCH_CONSTRAINTS,
  ORDER_TYPES,
  DIRECTIONS,
  REJECTION_REASONS,
  // events
  EventDispatcher,
  CreateOrderEvent,
  UpdatedOrderEvent,
  CancelOrderEvent,
  TradeEvent,
  RejectOrderEvent,
  OrderBookPublishedEvent,
  // data structures
  SimpleOrder,
  Bucket,
  SimpleOrderBook,
  PersistentOrder,
  PersistentOrderBook,
  EngineGateway
};
