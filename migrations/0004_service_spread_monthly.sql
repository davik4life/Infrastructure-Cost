-- Yearly services can be left out of the monthly figures (a once-a-year payment such as the domain).
-- 1 = spread over 12 months in the monthly run-rate (the default, as before), 0 = counted once a year only.
ALTER TABLE services ADD COLUMN spread_monthly INTEGER NOT NULL DEFAULT 1 CHECK (spread_monthly IN (0, 1));
