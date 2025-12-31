-- Custom Network Backend schema
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS balances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  currency TEXT NOT NULL,
  total NUMERIC(32,8) DEFAULT 0,
  available NUMERIC(32,8) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  price NUMERIC(32,8),
  size NUMERIC(32,8) NOT NULL,
  filled NUMERIC(32,8) DEFAULT 0,
  status TEXT NOT NULL,
  fee NUMERIC(32,8) DEFAULT 0,
  fee_coin TEXT,
  fee_structure JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  price NUMERIC(32,8) NOT NULL,
  size NUMERIC(32,8) NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposits (
  id UUID PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  currency TEXT,
  amount NUMERIC(32,8),
  status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id UUID PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  currency TEXT,
  amount NUMERIC(32,8),
  address TEXT,
  status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
