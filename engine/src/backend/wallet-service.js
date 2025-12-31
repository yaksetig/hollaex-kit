const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const { toAtomic, toDisplay } = require('./amounts');
const { Ledger } = require('./ledger');

class WalletService {
  constructor(store, { confirmationTarget = 2 } = {}) {
    this.store = store;
    this.ledger = new Ledger(store);
    this.confirmationTarget = confirmationTarget;
    this.onChainBalances = new Map();

    config.assets.forEach((asset) => {
      this.onChainBalances.set(asset, store.calculateLedgerBalance(asset));
    });
  }

  getOnChainBalance(currency) {
    return this.onChainBalances.get(currency) || 0n;
  }

  applyOnChainDelta(currency, deltaAtomic) {
    const current = this.getOnChainBalance(currency);
    const updated = current + BigInt(deltaAtomic || 0);
    this.onChainBalances.set(currency, updated);
    return updated;
  }

  async createAddress({ userId, asset, network }) {
    const address = `custody-${asset}-${network || 'mainnet'}-${uuidv4()}`;
    return this.store.saveAddress({
      id: uuidv4(),
      user_id: String(userId),
      asset,
      network: network || 'mainnet',
      address,
      created_at: new Date().toISOString(),
    });
  }

  async requestWithdrawal({ userId, currency, amount, address, network }) {
    const atomicAmount = toAtomic(amount);
    const withdrawal = this.store.createWithdrawalTransaction({
      user_id: String(userId),
      currency,
      amount: toDisplay(atomicAmount),
      amount_atomic: atomicAmount,
      address,
      network: network || 'mainnet',
      status: 'processing',
      confirmations: 0,
      confirmation_required: this.confirmationTarget,
      reconciliation_state: 'pending',
    });

    this.store.createHoldForWithdrawal(withdrawal.id, userId, currency, atomicAmount);

    const tx_hash = `tx-${withdrawal.id}`;
    return this.store.updateWithdrawal(withdrawal.id, {
      tx_hash,
      status: 'broadcasted',
    });
  }

  recordIncomingDeposit({ user_id, currency, amount, address, tx_hash, network, confirmations = 0 }) {
    const atomicAmount = toAtomic(amount);
    const existing = tx_hash ? this.store.findDepositByTx(tx_hash) : null;

    if (existing) {
      return this.store.updateDeposit(existing.id, { confirmations });
    }

    const deposit = this.store.createDepositTransaction({
      user_id: String(user_id),
      currency,
      amount: toDisplay(atomicAmount),
      amount_atomic: atomicAmount,
      address,
      tx_hash,
      network: network || 'mainnet',
      confirmations,
      confirmation_required: this.confirmationTarget,
      reconciliation_state: 'pending',
    });

    return deposit;
  }

  pollConfirmations() {
    const updated = [];

    this.store.getPendingDeposits().forEach((deposit) => {
      const confirmations = deposit.confirmations + 1;
      const patched = this.store.updateDeposit(deposit.id, { confirmations });
      updated.push(patched);
      this.evaluateDepositProgress(patched);
    });

    this.store.getPendingWithdrawals().forEach((withdrawal) => {
      const confirmations = withdrawal.confirmations + 1;
      const patched = this.store.updateWithdrawal(withdrawal.id, { confirmations });
      updated.push(patched);
      this.evaluateWithdrawalProgress(patched);
    });

    return updated;
  }

  evaluateDepositProgress(deposit) {
    if (!deposit) return deposit;

    if (deposit.confirmations >= deposit.confirmation_required) {
      return this.settleDeposit(deposit);
    }

    if (deposit.status !== 'confirming') {
      return this.store.updateDeposit(deposit.id, { status: 'confirming' });
    }

    return deposit;
  }

  evaluateWithdrawalProgress(withdrawal) {
    if (!withdrawal) return withdrawal;

    if (withdrawal.confirmations >= withdrawal.confirmation_required) {
      return this.settleWithdrawal(withdrawal);
    }

    if (withdrawal.status !== 'confirming') {
      return this.store.updateWithdrawal(withdrawal.id, { status: 'confirming' });
    }

    return withdrawal;
  }

  settleDeposit(deposit) {
    const amountAtomic = deposit.amount_atomic || toAtomic(deposit.amount);
    this.applyOnChainDelta(deposit.currency, amountAtomic);

    const ledgerBalance = this.store.calculateLedgerBalance(deposit.currency);
    const targetLedger = ledgerBalance + BigInt(amountAtomic);
    const onChainBalance = this.getOnChainBalance(deposit.currency);
    const reconciliation_state = targetLedger === onChainBalance ? 'reconciled' : 'mismatch';

    if (reconciliation_state === 'reconciled') {
      this.ledger.recordEntry({
        user_id: deposit.user_id,
        currency: deposit.currency,
        change: deposit.amount,
        reference: `deposit:${deposit.id}`,
      });

      return this.store.updateDeposit(deposit.id, {
        status: 'completed',
        reconciliation_state,
      });
    }

    return this.store.updateDeposit(deposit.id, {
      status: 'pending_reconciliation',
      reconciliation_state,
    });
  }

  settleWithdrawal(withdrawal) {
    const amountAtomic = withdrawal.amount_atomic || toAtomic(withdrawal.amount);
    this.applyOnChainDelta(withdrawal.currency, -amountAtomic);

    const ledgerBalance = this.store.calculateLedgerBalance(withdrawal.currency);
    const targetLedger = ledgerBalance - BigInt(amountAtomic);
    const onChainBalance = this.getOnChainBalance(withdrawal.currency);
    const reconciliation_state = targetLedger === onChainBalance ? 'reconciled' : 'mismatch';

    if (reconciliation_state === 'reconciled') {
      this.store.applyWithdrawalSettlement(withdrawal.id, amountAtomic);
      return this.store.updateWithdrawal(withdrawal.id, {
        status: 'completed',
        reconciliation_state,
      });
    }

    return this.store.updateWithdrawal(withdrawal.id, {
      status: 'pending_reconciliation',
      reconciliation_state,
    });
  }
}

module.exports = { WalletService };
