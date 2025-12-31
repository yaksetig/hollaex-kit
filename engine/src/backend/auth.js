const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { credentialStore } = require('./credential-store');

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

const issueJwt = (userId, permissions = config.auth.defaultKeyPermissions) =>
  jwt.sign({ sub: String(userId), permissions, exchange: config.exchange.id }, config.auth.jwtSecret, {
    expiresIn: config.auth.jwtTtl,
  });

const parseJwt = (token) => {
  try {
    return jwt.verify(token, config.auth.jwtSecret);
  } catch (error) {
    return null;
  }
};

const hasPermission = (auth, permission) => (auth?.permissions || []).includes(permission);

const authenticateRequest = (req) => {
  const bearer = headerName(req, 'authorization');
  const apiKey = headerName(req, 'api-key');
  const signature = headerName(req, 'api-signature');
  const expires = headerName(req, 'api-expires') || headerName(req, 'api-expiry');
  const timestamp = headerName(req, 'api-timestamp');

  if (bearer && bearer.toLowerCase().startsWith('bearer ')) {
    const token = bearer.slice(7);
    const payload = parseJwt(token);
    if (payload && payload.exchange === config.exchange.id) {
      return { mode: 'jwt', userId: payload.sub, permissions: payload.permissions || [] };
    }
  }

  if (!apiKey || !signature || !expires) {
    return null;
  }

  const record = credentialStore.getActiveKey(apiKey);
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
    return { mode: 'hmac', userId: record.userId, permissions: record.permissions || [] };
  }

  if (timestamp) {
    const computedWithTs = createSignature(record.secret, req.method.toUpperCase(), path, timestamp, body);
    if (timingSafeEqual(computedWithTs, signature)) {
      return { mode: 'hmac', userId: record.userId, permissions: record.permissions || [] };
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

const requirePermission = (permission) => (req, res, next) => {
  if (!req.auth) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  if (!hasPermission(req.auth, permission)) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
};

module.exports = {
  authMiddleware,
  requireAuth,
  authenticateRequest,
  requirePermission,
  hasPermission,
  issueJwt,
};
