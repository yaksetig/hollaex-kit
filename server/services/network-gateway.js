'use strict';

const EventEmitter = require('events');
const Network = require('hollaex-network-lib');
const WebSocket = require('ws');

const DEFAULT_CHANNELS = ['orderbook', 'trade'];

class NetworkGateway extends EventEmitter {
        constructor({
                apiKey,
                apiSecret,
                activation_code,
                exchange_id,
                apiExpiresAfter = 60,
                websocketChannels = DEFAULT_CHANNELS,
                additionalHeaders = {},
                logger,
                reconnectInterval = 5000
        } = {}) {
                super();
                this.network = new Network({
                        apiKey,
                        apiSecret,
                        activation_code,
                        exchange_id,
                        apiExpiresAfter
                });
                this.logger = logger || console;
                this.websocketChannels = websocketChannels;
                this.additionalHeaders = additionalHeaders;
                this.reconnectInterval = reconnectInterval;
                this.connectionTimer = null;
                this.connected = false;
        }

        async init() {
                this.logger.info('network-gateway/init');
                const info = await this.network.init({ additionalHeaders: this.additionalHeaders });
                this.logger.info('network-gateway/init/success', info);
                return info;
        }

        async connectWebsocket(channels = this.websocketChannels) {
                this.logger.info('network-gateway/ws/connect', channels);
                await this._ensureInit();
                this.network.connect(channels);
                this._wireWebsocketHandlers();
        }

        subscribePrivateChannels({ userId, includeWallet = true }) {
                const channels = [`order:${userId}`];
                if (includeWallet) {
                        channels.push(`wallet:${userId}`);
                }
                this.logger.info('network-gateway/ws/subscribe', channels);
                this.network.subscribe(channels);
        }

        unsubscribePrivateChannels({ userId, includeWallet = true }) {
                const channels = [`order:${userId}`];
                if (includeWallet) {
                        channels.push(`wallet:${userId}`);
                }
                this.logger.info('network-gateway/ws/unsubscribe', channels);
                this.network.unsubscribe(channels);
        }

        disconnectWebsocket() {
                this.logger.info('network-gateway/ws/disconnect');
                this.network.disconnect();
        }

        async healthcheck() {
                return {
                        connected: this.connected,
                        reconnecting: Boolean(this.connectionTimer)
                };
        }

        async refreshExchangeInfo() {
                return this.network.init({ additionalHeaders: this.additionalHeaders });
        }

        async proxy(method, ...args) {
                if (typeof this.network[method] !== 'function') {
                        throw new Error(`Unknown network method ${method}`);
                }
                await this._ensureInit();
                return this.network[method](...args);
        }

        async createOrder(userId, orderPayload) {
                return this.proxy('createOrder', userId, orderPayload.symbol, orderPayload.side, orderPayload.size, orderPayload.type, orderPayload.price, orderPayload.feeData, orderPayload.opts || {});
        }

        async cancelOrder(userId, orderId, opts = {}) {
                return this.proxy('cancelOrder', userId, orderId, opts);
        }

        async cancelAllOrders(userId, symbol, opts = {}) {
                return this.proxy('cancelAllOrders', userId, symbol, opts);
        }

        async getUserBalance(userId, opts = {}) {
                return this.proxy('getUserBalance', userId, opts);
        }

        async getUser(userId, opts = {}) {
                return this.proxy('getUser', userId, opts);
        }

        async mintAsset(userId, currency, amount, opts = {}) {
                return this.proxy('mintAsset', userId, currency, amount, opts);
        }

        async burnAsset(userId, currency, amount, opts = {}) {
                return this.proxy('burnAsset', userId, currency, amount, opts);
        }

        async performWithdrawal(userId, address, currency, amount, opts = {}) {
                return this.proxy('performWithdrawal', userId, address, currency, amount, opts);
        }

        async transferAsset(senderId, receiverId, currency, amount, opts = {}) {
                return this.proxy('transferAsset', senderId, receiverId, currency, amount, opts);
        }

        _wireWebsocketHandlers() {
                if (this.wsWired) return;
                this.wsWired = true;

                this.network.on(WebSocket.OPEN, () => {
                        this.connected = true;
                        this.logger.info('network-gateway/ws/open');
                        if (this.connectionTimer) {
                                clearTimeout(this.connectionTimer);
                                this.connectionTimer = null;
                        }
                        this.emit('ws:open');
                });

                this.network.on(WebSocket.CLOSE, () => {
                        this.connected = false;
                        this.logger.warn('network-gateway/ws/close');
                        this.emit('ws:close');
                        this._scheduleReconnect();
                });

                this.network.on(WebSocket.ERROR, (err) => {
                        this.logger.error('network-gateway/ws/error', err.message || err);
                        this.emit('ws:error', err);
                });

                this.network.on('message', (message) => {
                        this.emit('ws:message', message);
                });
        }

        _scheduleReconnect() {
                if (this.connectionTimer) return;
                this.connectionTimer = setTimeout(async () => {
                        this.logger.info('network-gateway/ws/reconnect');
                        this.connectionTimer = null;
                        try {
                                await this.connectWebsocket();
                        } catch (err) {
                                this.logger.error('network-gateway/ws/reconnect/error', err.message || err);
                                this._scheduleReconnect();
                        }
                }, this.reconnectInterval);
        }

        async _ensureInit() {
                if (!this._initPromise) {
                        this._initPromise = this.network.init({ additionalHeaders: this.additionalHeaders });
                }
                return this._initPromise;
        }
}

module.exports = NetworkGateway;
