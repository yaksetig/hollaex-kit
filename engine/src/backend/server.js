const express = require('express');
const http = require('http');
const config = require('./config');
const { DataStore } = require('./data-store');
const { authMiddleware } = require('./auth');
const { buildRoutes } = require('./routes');
const { WebsocketHub } = require('./websocket');
const { initialize } = require('./startup');
const { buildHealthHandlers } = require('./health');

const app = express();
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);
app.use(authMiddleware);

const store = new DataStore();
const server = http.createServer(app);
const websocketHub = new WebsocketHub(server, store);

app.use('/v2', buildRoutes(store, websocketHub));

let serverReady = false;

const bootstrap = async () => {
  const pool = await initialize();
  const { health, readiness } = buildHealthHandlers({ pool, config });
  app.get('/health', health);
  app.get('/readiness', readiness);
  serverReady = true;

  if (require.main === module) {
    server.listen(config.server.port, () => {
      // eslint-disable-next-line no-console
      console.log(`Custom network backend listening on ${config.server.port}`);
    });
  }
};

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server', error);
  process.exitCode = 1;
});

module.exports = { app, server, websocketHub, store, serverReady };
