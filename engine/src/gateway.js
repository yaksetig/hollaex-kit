'use strict';

const { EventDispatcher, TradeEvent, CreateOrderEvent, UpdatedOrderEvent, CancelOrderEvent, RejectOrderEvent } = require('./events');
const { SimpleOrderBook } = require('./orderBook');
const { PersistentOrderBook } = require('./persistence');

class EngineGateway {
        constructor({
                symbol,
                matchConstraint,
                pricePrecision,
                amountPrecision,
                persistenceAdapter,
                networkGateway,
                logger = console,
                snapshotInterval = 10000
        }) {
                this.symbol = symbol;
                this.logger = logger;
                this.networkGateway = networkGateway;
                this.dispatcher = new EventDispatcher();
                this.book = new SimpleOrderBook({
                        symbol,
                        matchConstraint,
                        pricePrecision,
                        amountPrecision,
                        dispatcher: this.dispatcher
                });
                if (persistenceAdapter) {
                        this.persistentBook = new PersistentOrderBook(this.book, persistenceAdapter);
                        this.snapshotInterval = snapshotInterval;
                }
        }

        async restore() {
                if (!this.persistentBook) return;
                this.logger.info('engine-gateway/restore', this.symbol);
                await this.persistentBook.restore();
                this._startSnapshotting();
        }

        async submit(createParams) {
                const { id, side, price, size, type } = createParams;
                const event = new CreateOrderEvent(id, side, price, size, type);
                return this._handle(event);
        }

        async update(updateParams) {
                const { id, price, size } = updateParams;
                const event = new UpdatedOrderEvent(id, price, size);
                return this._handle(event);
        }

        async cancel(cancelParams) {
                const { id } = cancelParams;
                const event = new CancelOrderEvent(id);
                return this._handle(event);
        }

        attachNetworkObservers() {
                if (!this.networkGateway) return;
                this.dispatcher.on(TradeEvent, async (event) => {
                        this.logger.info('engine-gateway/network/trade', event);
                        this.networkGateway.emit('engine:trade', event);
                });
                this.dispatcher.on(RejectOrderEvent, async (event) => {
                        this.logger.warn('engine-gateway/network/reject', event.reason);
                        this.networkGateway.emit('engine:reject', event);
                });
                this.dispatcher.on(CreateOrderEvent, (event) => this.networkGateway.emit('engine:order:create', event));
                this.dispatcher.on(UpdatedOrderEvent, (event) => this.networkGateway.emit('engine:order:update', event));
                this.dispatcher.on(CancelOrderEvent, (event) => this.networkGateway.emit('engine:order:cancel', event));
        }

        getSnapshot() {
                return this.book.serialize();
        }

        _startSnapshotting() {
                if (!this.persistentBook || this.snapshotTimer) return;
                this.snapshotTimer = setInterval(() => {
                        this.logger.debug('engine-gateway/snapshot', this.symbol);
                        this.persistentBook.saveSnapshot();
                }, this.snapshotInterval);
        }

        _handle(event) {
                try {
                        return this.book.handle(event);
                } catch (err) {
                        this.logger.error('engine-gateway/handle/error', err.message || err);
                        throw err;
                }
        }
}

module.exports = EngineGateway;
