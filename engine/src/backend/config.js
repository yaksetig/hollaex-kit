const crypto = require('crypto');
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

const randomSecret = () => crypto.randomBytes(32).toString('hex');

module.exports = {
  server: {
    port: Number(env.CUSTOM_NETWORK_PORT || env.PORT || 3003),
  },
  exchange: {
    id: env.EXCHANGE_ID || 'custom-network',
    name: env.EXCHANGE_NAME || 'Custom Network Backend',
    activationCode: env.EXCHANGE_ACTIVATION_CODE || randomSecret(),
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
    storeFile: env.AUTH_STORE_FILE || path.join(__dirname, '../../db/auth.json'),
    jwtSecret: env.AUTH_JWT_SECRET || randomSecret(),
    jwtTtl: env.AUTH_JWT_TTL || '12h',
    defaultKeyPermissions: env.AUTH_DEFAULT_PERMISSIONS
      ? env.AUTH_DEFAULT_PERMISSIONS.split(',').map((p) => p.trim()).filter(Boolean)
      : ['read', 'trade', 'write'],
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
