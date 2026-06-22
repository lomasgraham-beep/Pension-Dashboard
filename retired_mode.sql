-- Increment 3 of "Retired mode": the household retired flag.
-- Run ONCE in Supabase before deploying. Defaults to false, so nothing changes
-- until you tick "Retired mode" on the Defaults page (Basic Data -> Defaults).
alter table op_modelling_parameters
  add column if not exists retired_mode boolean not null default false;
