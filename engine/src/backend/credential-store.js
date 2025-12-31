const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

class CredentialStore {
  constructor(filePath = config.auth.storeFile) {
    this.filePath = filePath;
    this.data = { apiKeys: [], activationCodes: [] };
    this.load();
    this.bootstrapActivationCode();
  }

  load() {
    try {
      const payload = fs.readFileSync(this.filePath, 'utf8');
      this.data = JSON.parse(payload);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // eslint-disable-next-line no-console
        console.warn('Failed to read credential store, using empty store', error);
      }
      this.persist();
    }
  }

  persist() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  bootstrapActivationCode() {
    if (!config.exchange.activationCode) return;
    const exists = this.data.activationCodes.find((record) => record.exchangeId === config.exchange.id);
    if (exists) {
      if (exists.code !== config.exchange.activationCode || exists.active === false) {
        exists.code = config.exchange.activationCode;
        exists.active = true;
        exists.updatedAt = new Date().toISOString();
        this.persist();
      }
      return;
    }
    this.data.activationCodes.push({
      exchangeId: config.exchange.id,
      code: config.exchange.activationCode,
      active: true,
      createdAt: new Date().toISOString(),
    });
    this.persist();
  }

  generateKey() {
    return crypto.randomBytes(16).toString('hex');
  }

  generateSecret() {
    return crypto.randomBytes(32).toString('hex');
  }

  createApiKey({ userId, permissions = config.auth.defaultKeyPermissions }) {
    const apiKey = this.generateKey();
    const secret = this.generateSecret();
    const record = {
      apiKey,
      secret,
      userId: String(userId),
      permissions: permissions && permissions.length ? permissions : config.auth.defaultKeyPermissions,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.data.apiKeys.push(record);
    this.persist();
    return { ...record, secret };
  }

  getActiveKey(apiKey) {
    return this.data.apiKeys.find((record) => record.apiKey === apiKey && !record.revokedAt) || null;
  }

  revokeKey(apiKey) {
    const record = this.data.apiKeys.find((item) => item.apiKey === apiKey && !item.revokedAt);
    if (!record) return null;
    record.revokedAt = new Date().toISOString();
    this.persist();
    return record;
  }

  listKeys(userId) {
    const normalizedId = userId ? String(userId) : null;
    return this.data.apiKeys.filter((record) => (!normalizedId || record.userId === normalizedId));
  }

  validateActivationCode(code, exchangeId) {
    return this.data.activationCodes.find(
      (record) => record.code === code && record.exchangeId === exchangeId && record.active !== false
    );
  }
}

const credentialStore = new CredentialStore();

module.exports = { credentialStore };
