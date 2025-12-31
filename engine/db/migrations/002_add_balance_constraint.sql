ALTER TABLE IF EXISTS balances
  ADD CONSTRAINT IF NOT EXISTS balances_user_currency_unique UNIQUE (user_id, currency);
