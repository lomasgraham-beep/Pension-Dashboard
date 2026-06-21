-- Run this ONCE in Supabase (SQL editor) BEFORE saving a plan on the new build.
-- Adds the persistent "Savings fund bills" switch to the modelling plan.
-- Default true = today's behaviour, so existing rows are unaffected.
alter table op_modelling_parameters
  add column if not exists savings_fund_bills boolean not null default true;
