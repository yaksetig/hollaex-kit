const crypto = require('crypto');
const config = require('./config');

const headerName = (req, name) => req.headers[name.toLowerCase()];

const timingSafeEqual = (a, b) => {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
};

const createSignature = (secret, verb, path, expires, data = '') => {
  const stringData = typeof data === 'string' ? data : JSON.stringify(data || '');
  return crypto.createHmac('sha256', secret).update(verb + path + expires + stringData).digest('hex');
};

const authenticateRequest = (req) => {
  const apiKey = headerName(req, 'api-key');
  const signature = headerName(req, 'api-signature');
  const expires = headerName(req, 'api-expires') || headerName(req, 'api-expiry');
  const timestamp = headerName(req, 'api-timestamp');
  const devToken = headerName(req, 'x-dev-token') || headerName(req, 'authorization');

  if (devToken && config.auth.devTokens.includes(devToken)) {
    return { mode: 'dev-token', userId: headerName(req, 'x-user-id') || config.auth.apiKeys[apiKey]?.userId || '1' };
  }

  if (!apiKey || !signature || !expires) {
    return null;
  }

  const record = config.auth.apiKeys[apiKey];
  if (!record) return null;

  const expiresInt = parseInt(expires, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Number.isFinite(expiresInt) && expiresInt < now) {
    return null;
  }

  const rawPath = req.originalUrl.split('?')[0];
  const search = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?')[1]}` : '';
  const path = `${rawPath}${search}`;
  const body = req.rawBody || '';
  const computed = createSignature(record.secret, req.method.toUpperCase(), path, expires, body);
  if (timingSafeEqual(computed, signature)) {
    return { mode: 'hmac', userId: record.userId };
  }

  // allow timestamp header fallback per prompt
  if (timestamp) {
    const computedWithTs = createSignature(record.secret, req.method.toUpperCase(), path, timestamp, body);
    if (timingSafeEqual(computedWithTs, signature)) {
      return { mode: 'hmac', userId: record.userId };
    }
  }

  return null;
};

const authMiddleware = (req, res, next) => {
  req.auth = authenticateRequest(req);
  next();
};

const requireAuth = (req, res, next) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
};

module.exports = {
  authMiddleware,
  requireAuth,
  authenticateRequest,
};
