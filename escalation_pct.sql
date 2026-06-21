-- Increment 1 of "Retired mode": per-income escalation rate.
-- Run ONCE in Supabase before deploying. Sets every existing income to 2.5%, so your
-- current projection is unchanged until you edit a row. Then set each DB pension's real
-- escalation on the Guaranteed Incomes page (0 = a flat, non-increasing pension).
alter table bd_guaranteed_incomes
  add column if not exists escalation_pct numeric not null default 0.025;
