-- db/migrations/004_add_kyc_verification.sql
-- Adds KYC (Know Your Customer) identity verification tables

CREATE TABLE IF NOT EXISTS kyc_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'needs_review')),
  
  -- Personal Info
  ssn_last_four VARCHAR(4),
  ssn_hash VARCHAR(64),
  date_of_birth DATE,
  
  -- Address Verification
  street_address TEXT,
  city TEXT,
  state VARCHAR(2),
  zip_code VARCHAR(5),
  country VARCHAR(2) DEFAULT 'US',
  
  -- Government ID
  id_type TEXT CHECK (id_type IN ('drivers_license', 'passport', 'state_id')),
  id_number VARCHAR(30),
  id_expiry_date DATE,
  id_issuing_state VARCHAR(2),
  
  -- Document URLs (for future integration with cloud storage)
  id_photo_url TEXT,
  selfie_photo_url TEXT,
  address_proof_url TEXT,
  
  -- Verification Details
  verified_at TIMESTAMP,
  rejected_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kyc_user_id ON kyc_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_verifications(status);
CREATE INDEX IF NOT EXISTS idx_kyc_created_at ON kyc_verifications(created_at);

-- Table for transaction disputes
CREATE TABLE IF NOT EXISTS transaction_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  dispute_type TEXT NOT NULL CHECK (dispute_type IN ('unauthorized', 'duplicate', 'incorrect_amount', 'other')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'closed')),
  resolution TEXT,
  resolution_amount NUMERIC(19, 2),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disputes_user_id ON transaction_disputes(user_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON transaction_disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_created_at ON transaction_disputes(created_at);
CREATE INDEX IF NOT EXISTS idx_disputes_account_id ON transaction_disputes(account_id);

-- Function to approve KYC
CREATE OR REPLACE FUNCTION approve_kyc_verification(p_kyc_id UUID)
RETURNS TABLE(success BOOLEAN, err TEXT) AS $function$
DECLARE
BEGIN
  UPDATE kyc_verifications
  SET status = 'approved', verified_at = NOW()
  WHERE id = p_kyc_id;
  
  success := true;
  RETURN NEXT;
END;
$function$ LANGUAGE plpgsql;

-- Function to reject KYC
CREATE OR REPLACE FUNCTION reject_kyc_verification(p_kyc_id UUID, p_reason TEXT)
RETURNS TABLE(success BOOLEAN, err TEXT) AS $function$
DECLARE
BEGIN
  UPDATE kyc_verifications
  SET status = 'rejected', rejected_reason = p_reason
  WHERE id = p_kyc_id;
  
  success := true;
  RETURN NEXT;
END;
$function$ LANGUAGE plpgsql;
