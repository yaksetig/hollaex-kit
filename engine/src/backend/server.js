const express = require('express');
const http = require('http');
const config = require('./config');
const { DataStore } = require('./data-store');
const { authMiddleware } = require('./auth');
const { buildRoutes } = require('./routes');
const { WebsocketHub } = require('./websocket');
const { Database } = require('./db');

const buildServer = async () => {
  const app = express();
  app.use(
    express.json({
      verify: (req, res, buf) => {
        req.rawBody = buf.toString();
      },
    })
  );
  app.use(authMiddleware);

  const database = new Database();
  await database.runMigrations();

  const store = new DataStore(database);
  await store.initialize();

  const server = http.createServer(app);
  const websocketHub = new WebsocketHub(server, store);

  app.use('/v2', buildRoutes(store, websocketHub));

  app.get('/health', (req, res) => res.json({ status: 'ok', exchange_id: config.exchange.id }));

  return { app, server, websocketHub, store };
};

if (require.main === module) {
  buildServer().then(({ server }) => {
    server.listen(config.server.port, () => {
      // eslint-disable-next-line no-console
      console.log(`Custom network backend listening on ${config.server.port}`);
    });
  });
}

module.exports = { buildServer };
