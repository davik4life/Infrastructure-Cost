-- Zyria infrastructure cost register.
-- Money is stored as whole minor units (kobo / cents) and exchange rates as NGN per 1 USD x 100,
-- so nothing is rounded by floating point.

CREATE TABLE services (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  used_for    TEXT NOT NULL DEFAULT '',
  plan        TEXT NOT NULL DEFAULT '',
  billing     TEXT NOT NULL CHECK (billing IN ('MONTHLY','YEARLY','USAGE','FREE')),
  price_minor INTEGER NOT NULL DEFAULT 0,          -- expected cost per billing period
  currency    TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','NGN')),
  renews_on   TEXT,                                -- YYYY-MM-DD
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  next_tier   TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE entries (
  id           TEXT PRIMARY KEY,
  service_id   TEXT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  period       TEXT NOT NULL,                      -- YYYY-MM, the month the bill covers
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency     TEXT NOT NULL CHECK (currency IN ('USD','NGN')),
  fx_x100      INTEGER NOT NULL DEFAULT 100,       -- NGN per 1 USD x 100; 100 for NGN bills
  ngn_kobo     INTEGER NOT NULL,                   -- the bill in naira, fixed at the rate entered
  paid_on      TEXT,                               -- YYYY-MM-DD
  note         TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX entries_period ON entries(period);
CREATE INDEX entries_service_period ON entries(service_id, period);

CREATE TABLE settings (
  id      TEXT PRIMARY KEY,
  fx_x100 INTEGER NOT NULL
);

-- Who changed what. Emails come from the Cloudflare Access sign-in.
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  email      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_at ON audit_log(at);

INSERT INTO settings (id, fx_x100) VALUES ('default', 133500);

-- The services Zyria runs on as of 20 Oct 2026. Edit them in the app.
INSERT INTO services (id, name, category, used_for, plan, billing, price_minor, currency, next_tier, notes) VALUES
('vercel', 'Vercel', 'Hosting', 'Hosts zyria.ng and staging.zyria.ng, builds, daily cron jobs, firewall', 'Hobby (free)', 'FREE', 0, 'USD', 'Pro, needed for commercial use, more-than-daily crons and higher limits', ''),
('neon', 'Neon', 'Database', 'PostgreSQL: main (production) and dev (staging) branches', 'Free', 'FREE', 0, 'USD', 'Launch, for a 7-day restore window and no branch archiving', 'Billed through the Vercel marketplace'),
('cloudflare', 'Cloudflare DNS & Email Routing', 'Domain & DNS', 'DNS for zyria.ng; forwards support@, hello@ and accounts@ to Gmail', 'Free', 'FREE', 0, 'USD', '', ''),
('cloudflare-workers', 'Cloudflare Workers, D1 & Access', 'Hosting', 'Hosts this cost register on costs.zyria.ng', 'Free', 'FREE', 0, 'USD', '', 'Access is free for up to 50 users'),
('r2', 'Cloudflare R2', 'Storage & media', 'Product and store images on images.zyria.ng', 'Free tier (10 GB)', 'USAGE', 0, 'USD', 'Pay per GB once storage passes the free allowance', ''),
('domain', 'zyria.ng domain', 'Domain & DNS', 'Domain registration', 'Annual renewal', 'YEARLY', 0, 'NGN', '', 'Enter the registrar''s renewal price and date'),
('resend', 'Resend', 'Email', 'Transactional email from accounts@zyria.ng', 'Free (100 emails a day)', 'FREE', 0, 'USD', 'Pro, once daily email volume passes 100', ''),
('sentry', 'Sentry', 'Monitoring', 'Error monitoring for browser and server', 'Developer (free)', 'FREE', 0, 'USD', 'Team, if the free event quota runs out', ''),
('upstash', 'Upstash Redis', 'Cache & rate limits', 'Shared rate limits and Shipbubble quote cache', 'Free', 'USAGE', 0, 'USD', 'Pay as you go, past the free daily commands', ''),
('openai', 'OpenAI API', 'AI', 'Zyria Support assistant (production only)', 'Pay as you go', 'USAGE', 0, 'USD', '', 'Record the monthly invoice'),
('github', 'GitHub', 'Dev tools', 'Code, Dependabot, nightly encrypted database backups (Actions)', 'Free', 'FREE', 0, 'USD', '', ''),
('paystack', 'Paystack', 'Payments', 'Card and bank payments, seller payouts', 'Per transaction', 'USAGE', 0, 'NGN', '', 'Record the month''s total fees from the Paystack dashboard'),
('shipbubble', 'Shipbubble', 'Logistics', 'Delivery rates, labels and tracking', 'Per shipment', 'USAGE', 0, 'NGN', '', 'Only record what Zyria pays, not what buyers pay');
