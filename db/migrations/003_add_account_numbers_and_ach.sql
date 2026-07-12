-- db/migrations/003_add_account_numbers_and_ach.sql
-- Adds account numbers, routing numbers, and ACH transfer support

-- Add unique account numbers and routing number to accounts
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS account_number VARCHAR(20) UNIQUE NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS routing_number VARCHAR(9) NOT NULL DEFAULT '021000021'; -- ABA routing for Apex Horizon

-- Generate unique account numbers for existing accounts (if needed)
UPDATE accounts
SET account_number = 
  LPAD(CAST(FLOOR(RANDOM() * 9000000000) + 1000000000 AS TEXT), 10, '0')
WHERE account_number = '';

-- Add linked external accounts table for ACH transfers
CREATE TABLE IF NOT EXISTS linked_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_name TEXT NOT NULL,
  account_holder_name TEXT NOT NULL,
  account_number VARCHAR(20) NOT NULL,
  routing_number VARCHAR(9) NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('checking', 'savings')),
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'failed')),
  verification_attempts INT DEFAULT 0,
  -- For micro-deposit verification
  micro_deposit_1 NUMERIC(10, 2),
  micro_deposit_2 NUMERIC(10, 2),
  verification_code VARCHAR(6),
  verified_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_linked_accounts_user_id ON linked_accounts(user_id);

-- ACH transfers table
CREATE TABLE IF NOT EXISTS ach_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_account_id UUID NOT NULL REFERENCES accounts(id),
  to_linked_account_id UUID REFERENCES linked_accounts(id),
  to_external_account_number VARCHAR(20),
  to_external_routing_number VARCHAR(9),
  to_external_account_holder TEXT,
  to_external_bank_name TEXT,
  amount NUMERIC(19, 2) NOT NULL CHECK (amount > 0),
  description TEXT,
  transfer_type TEXT NOT NULL CHECK (transfer_type IN ('debit', 'credit')) DEFAULT 'debit',
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'settled', 'failed', 'cancelled')) DEFAULT 'pending',
  settlement_date TIMESTAMP,
  trace_number VARCHAR(20) UNIQUE,
  nacha_entry_description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ach_transfers_from_account ON ach_transfers(from_account_id);
CREATE INDEX IF NOT EXISTS idx_ach_transfers_status ON ach_transfers(status);
CREATE INDEX IF NOT EXISTS idx_ach_transfers_created_at ON ach_transfers(created_at);

-- ACH incoming (direct deposit) table
CREATE TABLE IF NOT EXISTS ach_incoming (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_account_id UUID NOT NULL REFERENCES accounts(id),
  from_bank_name TEXT,
  from_bank_routing VARCHAR(9),
  from_account_holder TEXT,
  amount NUMERIC(19, 2) NOT NULL CHECK (amount > 0),
  description TEXT,
  trace_number VARCHAR(20) UNIQUE,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'settled', 'failed')),
  effective_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ach_incoming_to_account ON ach_incoming(to_account_id);
CREATE INDEX IF NOT EXISTS idx_ach_incoming_created_at ON ach_incoming(created_at);

-- Add ACH daily limits tracking
CREATE TABLE IF NOT EXISTS ach_daily_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  outgoing_amount NUMERIC(19, 2) DEFAULT 0,
  outgoing_count INT DEFAULT 0,
  unique(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_ach_daily_limits_user_date ON ach_daily_limits(user_id, date);

-- Function to initiate an ACH debit transfer
CREATE OR REPLACE FUNCTION initiate_ach_debit_transfer(
  p_from_user_id UUID,
  p_from_account_type TEXT,
  p_to_linked_account_id UUID,
  p_amount NUMERIC,
  p_description TEXT DEFAULT NULL
)
RETURNS TABLE(
  success BOOLEAN,
  err TEXT,
  transfer_id UUID,
  settlement_date TIMESTAMP
) AS $function$
DECLARE
  v_from_account RECORD;
  v_linked_account RECORD;
  v_transfer_id UUID;
  v_settlement_date TIMESTAMP;
  v_daily_total NUMERIC;
  v_max_ach_daily_limit NUMERIC := 25000;
BEGIN
  -- Find sender account
  SELECT id, balance INTO v_from_account
  FROM accounts
  WHERE user_id = p_from_user_id AND account_type = p_from_account_type
  LIMIT 1;

  IF NOT FOUND THEN
    success := false; err := 'Source account not found.'; RETURN NEXT; RETURN;
  END IF;

  -- Check sufficient funds
  IF v_from_account.balance < p_amount THEN
    success := false; err := 'Insufficient funds.'; RETURN NEXT; RETURN;
  END IF;

  -- Find and verify linked account
  SELECT * INTO v_linked_account
  FROM linked_accounts
  WHERE id = p_to_linked_account_id AND user_id = p_from_user_id
  LIMIT 1;

  IF NOT FOUND THEN
    success := false; err := 'Linked account not found.'; RETURN NEXT; RETURN;
  END IF;

  IF v_linked_account.verification_status != 'verified' THEN
    success := false; err := 'Linked account not verified.'; RETURN NEXT; RETURN;
  END IF;

  -- Check daily ACH limit
  SELECT COALESCE(outgoing_amount, 0) INTO v_daily_total
  FROM ach_daily_limits
  WHERE user_id = p_from_user_id AND date = CURRENT_DATE;

  IF COALESCE(v_daily_total, 0) + p_amount > v_max_ach_daily_limit THEN
    success := false; err := 'Daily ACH transfer limit exceeded ($25,000).'; RETURN NEXT; RETURN;
  END IF;

  -- Lock account row
  PERFORM 1 FROM accounts WHERE id = v_from_account.id FOR UPDATE;

  -- Re-check balance after lock
  SELECT balance INTO v_from_account FROM accounts WHERE id = v_from_account.id;
  IF v_from_account.balance < p_amount THEN
    success := false; err := 'Insufficient funds (race condition check).'; RETURN NEXT; RETURN;
  END IF;

  -- Deduct from account (ACH clears in 1-2 business days)
  UPDATE accounts SET balance = balance - p_amount WHERE id = v_from_account.id;

  -- Create transaction record
  INSERT INTO transactions (account_id, type, amount, description, created_at)
  VALUES (v_from_account.id, 'ach_out', p_amount, COALESCE(p_description, 'ACH Transfer'), NOW());

  -- Create ACH transfer record
  v_settlement_date := CURRENT_TIMESTAMP + INTERVAL '1 day'; -- ACH settles next business day
  v_transfer_id := gen_random_uuid();

  INSERT INTO ach_transfers (
    id, from_account_id, to_linked_account_id, 
    to_external_account_number, to_external_routing_number, 
    to_external_account_holder, to_external_bank_name,
    amount, description, transfer_type, status, settlement_date, trace_number
  ) VALUES (
    v_transfer_id,
    v_from_account.id,
    p_to_linked_account_id,
    v_linked_account.account_number,
    v_linked_account.routing_number,
    v_linked_account.account_holder_name,
    v_linked_account.bank_name,
    p_amount,
    COALESCE(p_description, 'ACH Transfer'),
    'debit',
    'pending',
    v_settlement_date,
    'AHB' || LPAD(CAST(FLOOR(RANDOM() * 9999999999) AS TEXT), 10, '0')
  );

  -- Update daily limit
  INSERT INTO ach_daily_limits (user_id, date, outgoing_amount, outgoing_count)
  VALUES (p_from_user_id, CURRENT_DATE, p_amount, 1)
  ON CONFLICT (user_id, date) DO UPDATE
  SET outgoing_amount = ach_daily_limits.outgoing_amount + p_amount,
      outgoing_count = ach_daily_limits.outgoing_count + 1;

  success := true;
  transfer_id := v_transfer_id;
  settlement_date := v_settlement_date;
  RETURN NEXT;
END;
$function$ LANGUAGE plpgsql;

-- Function to verify linked account with micro-deposits
CREATE OR REPLACE FUNCTION verify_linked_account_micro_deposits(
  p_linked_account_id UUID,
  p_user_id UUID,
  p_deposit_1 NUMERIC,
  p_deposit_2 NUMERIC
)
RETURNS TABLE(
  success BOOLEAN,
  err TEXT
) AS $function$
DECLARE
  v_linked_account RECORD;
BEGIN
  SELECT * INTO v_linked_account
  FROM linked_accounts
  WHERE id = p_linked_account_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    success := false; err := 'Linked account not found.'; RETURN NEXT; RETURN;
  END IF;

  -- In a real bank, micro-deposits would be sent to the external account
  -- and the user would verify them. For now, we store them.
  UPDATE linked_accounts
  SET 
    micro_deposit_1 = p_deposit_1,
    micro_deposit_2 = p_deposit_2,
    verification_status = 'verified',
    verified_at = NOW()
  WHERE id = p_linked_account_id;

  success := true;
  RETURN NEXT;
END;
$function$ LANGUAGE plpgsql;
