-- Lets a bill be kept in the ledger but left out of every total (one-offs, refunds, duplicates, tests).
-- 1 = counted (the default, and what every existing bill becomes), 0 = not counted.
ALTER TABLE entries ADD COLUMN counted INTEGER NOT NULL DEFAULT 1 CHECK (counted IN (0, 1));
