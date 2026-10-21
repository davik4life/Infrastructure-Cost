-- What was actually paid for a bill, in kobo, when it differs from the service fee
-- (bank charges, VAT, card FX spread, delivery top-ups). NULL = paid exactly the fee.
-- The difference (charged_kobo - ngn_kobo) is shown as "miscellaneous".
ALTER TABLE entries ADD COLUMN charged_kobo INTEGER CHECK (charged_kobo IS NULL OR charged_kobo >= 0);
