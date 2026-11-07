-- Custom SQL migration: keeps every statement match pointing at a live, consistent ledger row.
-- Foreign keys already block hard deletes; these triggers cover status changes, which a
-- foreign key cannot see. Both triggers lock the same transactions row, so a concurrent
-- void and match confirmation are serialized: one of them fails.

-- 1. A matched ledger row cannot be voided, cancelled, un-cleared or have its amount,
--    account, type or cleared date changed. Unmatch first. issued -> cleared stays allowed:
--    confirming a cheque match clears the cheque.
CREATE FUNCTION public.statement_match_guard_transaction() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.statement_matches m WHERE m.transaction_id = OLD.id)
     AND (
       NEW.amount_minor <> OLD.amount_minor
       OR NEW.bank_account_id <> OLD.bank_account_id
       OR NEW.type <> OLD.type
       OR (
         (NEW.status <> OLD.status OR NEW.cleared_date IS DISTINCT FROM OLD.cleared_date)
         AND NOT (OLD.status = 'issued' AND NEW.status = 'cleared')
       )
     )
  THEN
    RAISE EXCEPTION 'transaction % is matched to a bank statement line; unmatch it first', OLD.id
      USING ERRCODE = 'P0001', HINT = 'matched_to_statement';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER statement_match_guard
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.statement_match_guard_transaction();
--> statement-breakpoint

-- 2. A match may only point at a live row (not voided or cancelled) of the same
--    organization and the same bank account as its statement line.
CREATE FUNCTION public.statement_match_guard_match() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  tx_org uuid;
  tx_account uuid;
  tx_status text;
  line_org uuid;
  line_account uuid;
BEGIN
  -- FOR UPDATE: waits for a concurrent void of this row and then sees its result.
  SELECT t.organization_id, t.bank_account_id, t.status
    INTO tx_org, tx_account, tx_status
    FROM public.transactions t
    WHERE t.id = NEW.transaction_id
    FOR UPDATE;
  SELECT l.organization_id, l.bank_account_id
    INTO line_org, line_account
    FROM public.statement_lines l
    WHERE l.id = NEW.statement_line_id;

  IF tx_status IN ('voided', 'cancelled') THEN
    RAISE EXCEPTION 'cannot match a % transaction', tx_status
      USING ERRCODE = 'P0001', HINT = 'match_target_not_live';
  END IF;
  IF tx_org IS DISTINCT FROM NEW.organization_id
     OR line_org IS DISTINCT FROM NEW.organization_id
     OR tx_account IS DISTINCT FROM line_account
  THEN
    RAISE EXCEPTION 'statement line and transaction must belong to the same account'
      USING ERRCODE = 'P0001', HINT = 'match_account_mismatch';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER statement_match_guard
  BEFORE INSERT OR UPDATE ON public.statement_matches
  FOR EACH ROW EXECUTE FUNCTION public.statement_match_guard_match();
