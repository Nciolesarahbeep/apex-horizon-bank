-- db/migrations/005_add_direct_deposit_table.sql
-- Already included in 004_add_account_numbers_and_ach.sql as ach_incoming
-- This is a reference migration - the ach_incoming table handles direct deposits

-- Verify ach_incoming table exists (created in migration 003)
-- ACH incoming transfers are direct deposits
-- See db/migrations/003_add_account_numbers_and_ach.sql for the table definition
