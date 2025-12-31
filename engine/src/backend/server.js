const express = require('express');
const http = require('http');
const config = require('./config');
const { DataStore } = require('./data-store');
const { authMiddleware } = require('./auth');
const { buildRoutes } = require('./routes');
const { WebsocketHub } = require('./websocket');
const { WalletService } = require('./wallet-service');
const { Database } = require('./db');
const { initialize } = require('./startup');

const buildServer = async () => {
  const db = new Database();
  await initialize();

  const app = express();
  app.use(
    express.json({
      verify: (req, res, buf) => {
        req.rawBody = buf.toString();
      },
    })
  );
  app.use(authMiddleware);

  const store = new DataStore(db);
  await store.initialize();
  const server = http.createServer(app);
  const websocketHub = new WebsocketHub(server, store);
  const walletService = new WalletService(store);

  app.use('/v2', buildRoutes(store, websocketHub, walletService));

  app.get('/health', (req, res) => res.json({ status: 'ok', exchange_id: config.exchange.id }));

  return { app, server, websocketHub, store, walletService, db };
};

if (require.main === module) {
  buildServer().then(({ server, db }) => {
    const shutdown = async () => {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    };

    process.on('SIGINT', () => shutdown());
    process.on('SIGTERM', () => shutdown());

    server.listen(config.server.port, () => {
      // eslint-disable-next-line no-console
      console.log(`Custom network backend listening on ${config.server.port}`);
    });
  });
}

module.exports = { buildServer };
