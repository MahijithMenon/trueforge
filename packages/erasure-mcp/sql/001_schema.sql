-- Tombstone demo estate: a small SaaS company's real data footprint.
-- Two schemas keep the story honest:
--   app_data  - the personal data an erasure request must reach
--   erasure   - the case file, plans, holds and tamper-evident audit trail

CREATE SCHEMA IF NOT EXISTS app_data;
CREATE SCHEMA IF NOT EXISTS erasure;

-- ---------------------------------------------------------------- app_data --

CREATE TABLE IF NOT EXISTS app_data.customers (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  phone         TEXT,
  address       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  erased_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS app_data.support_tickets (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   BIGINT NOT NULL REFERENCES app_data.customers(id) ON DELETE CASCADE,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_data.sessions (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   BIGINT NOT NULL REFERENCES app_data.customers(id) ON DELETE CASCADE,
  ip_address    TEXT NOT NULL,
  user_agent    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_data.marketing_events (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   BIGINT NOT NULL REFERENCES app_data.customers(id) ON DELETE CASCADE,
  event         TEXT NOT NULL,
  email_sent_to TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Invoices are the interesting case: tax law requires retention, so they are
-- NEVER hard-deleted. Only the personal-data columns may be redacted.
CREATE TABLE IF NOT EXISTS app_data.invoices (
  id             BIGSERIAL PRIMARY KEY,
  customer_id    BIGINT NOT NULL REFERENCES app_data.customers(id) ON DELETE RESTRICT,
  invoice_number TEXT NOT NULL UNIQUE,
  amount_cents   BIGINT NOT NULL,
  bill_to_name   TEXT,
  bill_to_email  TEXT,
  bill_to_address TEXT,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  redacted_at    TIMESTAMPTZ
);

-- Files uploaded by the customer; rows point at the object store on disk.
CREATE TABLE IF NOT EXISTS app_data.attachments (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   BIGINT NOT NULL REFERENCES app_data.customers(id) ON DELETE CASCADE,
  object_key    TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------- erasure --

-- An active legal hold makes a subject non-erasable, whatever the agent decides.
-- This is checked server-side at execution time, not by the model.
CREATE TABLE IF NOT EXISTS erasure.legal_holds (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   BIGINT NOT NULL REFERENCES app_data.customers(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,
  matter_ref    TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS legal_holds_customer_active_idx
  ON erasure.legal_holds(customer_id) WHERE active;

CREATE TABLE IF NOT EXISTS erasure.cases (
  id            TEXT PRIMARY KEY,
  customer_id   BIGINT NOT NULL REFERENCES app_data.customers(id) ON DELETE RESTRICT,
  requested_by  TEXT NOT NULL,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A plan is content-addressed. execute_erasure only accepts a stored plan id,
-- so the agent cannot smuggle an ad-hoc deletion scope into the destructive call.
CREATE TABLE IF NOT EXISTS erasure.plans (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES erasure.cases(id) ON DELETE CASCADE,
  customer_id   BIGINT NOT NULL,
  plan          JSONB NOT NULL,
  plan_hash     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erasure.receipts (
  id            TEXT PRIMARY KEY,
  plan_id       TEXT NOT NULL UNIQUE REFERENCES erasure.plans(id) ON DELETE RESTRICT,
  case_id       TEXT NOT NULL REFERENCES erasure.cases(id) ON DELETE RESTRICT,
  receipt       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hash-chained audit log: each entry commits to the previous one, so a
-- deleted or edited entry breaks the chain and is detectable.
CREATE TABLE IF NOT EXISTS erasure.audit_log (
  seq           BIGSERIAL PRIMARY KEY,
  case_id       TEXT,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  prev_hash     TEXT NOT NULL,
  entry_hash    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
