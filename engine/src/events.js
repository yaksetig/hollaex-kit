class EventDispatcher {
  constructor() {
    this.listeners = new Map();
  }

  on(eventName, listener) {
    const list = this.listeners.get(eventName) || [];
    list.push(listener);
    this.listeners.set(eventName, list);
  }

  dispatch(event) {
    const eventName = event.constructor.name;
    const listeners = this.listeners.get(eventName) || [];
    const wildcard = this.listeners.get('*') || [];
    [...listeners, ...wildcard].forEach((listener) => listener(event));
  }
}

class BaseEvent {
  constructor(payload) {
    Object.assign(this, payload);
  }
}

class CreateOrderEvent extends BaseEvent {}
class UpdatedOrderEvent extends BaseEvent {}
class CancelOrderEvent extends BaseEvent {}
class TradeEvent extends BaseEvent {}
class RejectOrderEvent extends BaseEvent {}
class OrderBookPublishedEvent extends BaseEvent {}

module.exports = {
  EventDispatcher,
  CreateOrderEvent,
  UpdatedOrderEvent,
  CancelOrderEvent,
  TradeEvent,
  RejectOrderEvent,
  OrderBookPublishedEvent
};
