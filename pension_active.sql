-- Increment 2 of "Retired mode": active/closed flag for DC consolidation.
-- Run ONCE in Supabase before deploying. Every existing pension stays Active,
-- so nothing changes until you set a consolidated pot to Closed on the Pensions page.
alter table bd_pensions
  add column if not exists active boolean not null default true;
