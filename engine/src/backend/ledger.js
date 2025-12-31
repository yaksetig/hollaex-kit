const { v4: uuidv4 } = require('uuid');
const { toAtomic, toDisplay } = require('./amounts');

class Ledger {
  constructor(store) {
    this.store = store;
    this.entries = [];
  }

  recordEntry({ user_id, currency, change, reference }) {
    const atomicChange = toAtomic(change);
    const balance = this.store.credit(user_id, currency, atomicChange);
    const entry = {
      id: uuidv4(),
      user_id: String(user_id),
      currency,
      change: toDisplay(atomicChange),
      total: toDisplay(balance.total),
      available: toDisplay(balance.available),
      reference,
      created_at: new Date().toISOString(),
    };
    this.entries.push(entry);
    return entry;
  }
}

module.exports = { Ledger };
