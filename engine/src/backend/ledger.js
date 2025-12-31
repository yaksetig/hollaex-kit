const { v4: uuidv4 } = require('uuid');
const { toAtomic, toDisplay } = require('./amounts');

class Ledger {
  constructor(store) {
    this.store = store;
  }

  recordEntry({ user_id, currency, change, reference }) {
    const atomicChange = toAtomic(change);
    const balance = this.store.credit(user_id, currency, atomicChange);

    const debit_account = atomicChange < 0 ? String(user_id) : 'external';
    const credit_account = atomicChange < 0 ? 'external' : String(user_id);

    const entry = {
      id: uuidv4(),
      debit_account,
      credit_account,
      currency,
      amount: toDisplay(atomicChange < 0 ? -atomicChange : atomicChange),
      ref: reference,
      created_at: new Date().toISOString(),
      total: toDisplay(balance.total),
      available: toDisplay(balance.available),
    };

    this.store.addLedgerEntry(entry);
    return entry;
  }
}

module.exports = { Ledger };
