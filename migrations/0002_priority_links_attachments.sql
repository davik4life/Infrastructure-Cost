-- Priority, payment links, paid/due status and screenshots.

ALTER TABLE services ADD COLUMN priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('CRITICAL','HIGH','MEDIUM','LOW'));
ALTER TABLE services ADD COLUMN payment_url TEXT NOT NULL DEFAULT '';

ALTER TABLE entries ADD COLUMN priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('CRITICAL','HIGH','MEDIUM','LOW'));
ALTER TABLE entries ADD COLUMN payment_url TEXT NOT NULL DEFAULT '';
-- Bills recorded before this change were already paid.
ALTER TABLE entries ADD COLUMN status TEXT NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID','DUE'));
CREATE INDEX entries_status ON entries(status);

-- Screenshots (payment plans, invoices, receipts). The files live in the private R2 bucket
-- bound as UPLOADS and are only served to signed-in admins.
CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  owner_type   TEXT NOT NULL CHECK (owner_type IN ('service','entry')),
  owner_id     TEXT NOT NULL,
  r2_key       TEXT NOT NULL UNIQUE,
  filename     TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX attachments_owner ON attachments(owner_type, owner_id);

-- Starting priorities: what takes Zyria down or stops payments if it lapses comes first.
UPDATE services SET priority = 'CRITICAL' WHERE id IN ('vercel','neon','cloudflare','domain','paystack');
UPDATE services SET priority = 'HIGH' WHERE id IN ('r2','resend','upstash','shipbubble');
UPDATE services SET priority = 'MEDIUM' WHERE id IN ('sentry','github','openai');
UPDATE services SET priority = 'LOW' WHERE id IN ('cloudflare-workers');
