-- db/migrations/001_p2p_transfer_function.sql
-- Creates a safe, transactional PL/pgSQL function to perform a P2P transfer
-- between a sender's account and a recipient's checking account. The
-- function validates existence, prevents self-send, checks sufficient
-- funds, locks both account rows, updates balances, and inserts
-- corresponding transactions. Returns a result row describing success or
-- error and the resulting balances.

CREATE OR REPLACE FUNCTION p2p_transfer_by_userids(
  p_sender_user_id uuid,
  p_from_account_type text,
  p_recipient_email text,
  p_amount numeric,
  p_description text DEFAULT NULL
)
RETURNS TABLE(
  success boolean,
  err text,
  from_account_id uuid,
  to_account_id uuid,
  from_balance numeric,
  to_balance numeric
) AS $function$
DECLARE
  v_from_acc RECORD;
  v_recipient_user RECORD;
  v_to_acc RECORD;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    success := false; err := 'Amount must be greater than zero.'; RETURN NEXT; RETURN;
  END IF;

  -- Find sender account
  SELECT id, balance INTO v_from_acc
  FROM accounts
  WHERE user_id = p_sender_user_id AND account_type = p_from_account_type
  LIMIT 1;

  IF NOT FOUND THEN
    success := false; err := 'Source account not found.'; RETURN NEXT; RETURN;
  END IF;

  -- Find recipient user by email (case-insensitive)
  SELECT id INTO v_recipient_user
  FROM users
  WHERE LOWER(email) = LOWER(p_recipient_email)
  LIMIT 1;

  IF NOT FOUND THEN
    success := false; err := 'Recipient not found.'; RETURN NEXT; RETURN;
  END IF;

  IF v_recipient_user.id = p_sender_user_id THEN
    success := false; err := 'Cannot send money to yourself.'; RETURN NEXT; RETURN;
  END IF;

  -- Recipient must have a checking account for P2P
  SELECT id, balance INTO v_to_acc
  FROM accounts
  WHERE user_id = v_recipient_user.id AND account_type = 'checking'
  LIMIT 1;

  IF NOT FOUND THEN
    success := false; err := 'Recipient does not have an eligible checking account.'; RETURN NEXT; RETURN;
  END IF;

  -- Lock both account rows to prevent race conditions
  PERFORM 1 FROM accounts WHERE id = v_from_acc.id FOR UPDATE;
  PERFORM 1 FROM accounts WHERE id = v_to_acc.id FOR UPDATE;

  -- Re-check balance after locking
  IF v_from_acc.balance < p_amount THEN
    success := false; err := 'Insufficient funds in the source account.'; RETURN NEXT; RETURN;
  END IF;

  -- Perform updates
  UPDATE accounts SET balance = balance - p_amount WHERE id = v_from_acc.id;
  UPDATE accounts SET balance = balance + p_amount WHERE id = v_to_acc.id;

  -- Insert transaction records
  INSERT INTO transactions (account_id, type, amount, description, created_at)
    VALUES (v_from_acc.id, 'p2p_out', p_amount, COALESCE(p_description, 'P2P transfer'), NOW());

  INSERT INTO transactions (account_id, type, amount, description, created_at)
    VALUES (v_to_acc.id, 'p2p_in', p_amount, COALESCE(p_description, 'P2P transfer received'), NOW());

  -- Return resulting balances
  SELECT balance INTO from_balance FROM accounts WHERE id = v_from_acc.id;
  SELECT balance INTO to_balance FROM accounts WHERE id = v_to_acc.id;

  from_account_id := v_from_acc.id;
  to_account_id := v_to_acc.id;
  success := true; err := NULL;
  RETURN NEXT;
  RETURN;

EXCEPTION WHEN others THEN
  -- Bubble up a gentle error message while returning success=false
  success := false;
  err := SQLERRM;
  from_account_id := NULL; to_account_id := NULL; from_balance := NULL; to_balance := NULL;
  RETURN NEXT;
  RETURN;
END;
$function$ LANGUAGE plpgsql VOLATILE;
