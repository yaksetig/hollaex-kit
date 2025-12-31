const path = require('path');

const env = process.env;

const DEFAULT_SCALE = 8n;
const MULTIPLIER = 10n ** DEFAULT_SCALE;

const toBigInt = (value) => {
  const normalized = typeof value === 'string' ? value : String(value ?? 0);
  const parts = normalized.split('.');
  const whole = BigInt(parts[0] || 0n);
  const fractional = parts[1] || '';
  const paddedFraction = (fractional + '0'.repeat(Number(DEFAULT_SCALE))).slice(0, Number(DEFAULT_SCALE));
  return whole * MULTIPLIER + BigInt(paddedFraction);
};

module.exports = {
  server: {
    port: Number(env.CUSTOM_NETWORK_PORT || env.PORT || 3003),
  },
  exchange: {
    id: env.EXCHANGE_ID || 'custom-network',
    name: env.EXCHANGE_NAME || 'Custom Network Backend',
    activationCode: env.EXCHANGE_ACTIVATION_CODE || 'dev-activation-code',
    createdAt: env.EXCHANGE_CREATED_AT || new Date().toISOString(),
  },
  assets: env.EXCHANGE_ASSETS
    ? env.EXCHANGE_ASSETS.split(',')
    : ['xht', 'usdt'],
  markets: env.EXCHANGE_MARKETS
    ? env.EXCHANGE_MARKETS.split(',').map((pair) => {
        const [base, quote] = pair.split('-');
        return { symbol: pair, base, quote, increment_price: '0.01', increment_size: '0.0001' };
      })
    : [
        { symbol: 'xht-usdt', base: 'xht', quote: 'usdt', increment_price: '0.01', increment_size: '0.0001' },
        { symbol: 'btc-usdt', base: 'btc', quote: 'usdt', increment_price: '0.1', increment_size: '0.0001' },
      ],
  auth: {
    devTokens: env.DEV_TOKENS ? env.DEV_TOKENS.split(',') : ['dev-access-token'],
    apiKeys: {
      [env.DEV_API_KEY || 'dev-api-key']: {
        secret: env.DEV_API_SECRET || 'dev-api-secret',
        userId: env.DEV_API_USER_ID || '1',
      },
    },
  },
  paths: {
    migrationsDir: path.join(__dirname, '../../db/migrations'),
    schemaFile: path.join(__dirname, '../../db/schema.sql'),
  },
  decimal: {
    scale: DEFAULT_SCALE,
    multiplier: MULTIPLIER,
    toBigInt,
  },
};
