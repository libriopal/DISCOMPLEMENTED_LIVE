CREATE TABLE IF NOT EXISTS eicca_contracts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  entity_name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('llc','c_corp','s_corp')),
  instrument_type TEXT NOT NULL CHECK(instrument_type IN ('rbf','safe','warrant')),
  credit_amount_usd REAL NOT NULL,
  revenue_share_percent REAL,
  repayment_cap REAL,
  valuation_cap REAL,
  discount_rate REAL,
  warrant_coverage_percent REAL,
  strike_price REAL,
  status TEXT NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','consented','active','repaying','completed','declined','defaulted','cancelled')),
  offer_expiry_date TEXT NOT NULL,
  contract_terms_json TEXT NOT NULL,
  contract_terms_hash TEXT NOT NULL,
  consent_signature TEXT,
  consent_timestamp TEXT,
  consent_ip TEXT,
  cancellation_deadline TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  activated_date TEXT,
  completed_date TEXT,
  UNIQUE(consent_signature)
);
CREATE INDEX IF NOT EXISTS idx_eicca_user ON eicca_contracts(user_id);
CREATE INDEX IF NOT EXISTS idx_eicca_status ON eicca_contracts(status);

CREATE TABLE IF NOT EXISTS eicca_credits (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES eicca_contracts(id),
  ledger_entry_id TEXT NOT NULL REFERENCES credit_ledger(id),
  amount_usd REAL NOT NULL,
  issued_date TEXT NOT NULL,
  revoked_date TEXT
);

CREATE TABLE IF NOT EXISTS eicca_repayments (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES eicca_contracts(id),
  amount_usd REAL NOT NULL CHECK(amount_usd > 0),
  revenue_base_usd REAL NOT NULL CHECK(revenue_base_usd >= 0),
  share_percent REAL NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_date TEXT NOT NULL,
  UNIQUE(idempotency_key)
);
