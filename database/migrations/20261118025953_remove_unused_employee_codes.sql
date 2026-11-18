SET LOCAL ROLE hr;

LOCK TABLE hr.employee IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM hr.employee WHERE card_no IS NOT NULL OR staff_code IS NOT NULL) THEN
    RAISE EXCEPTION 'Employee card or staff codes exist and must be reviewed before removal';
  END IF;
END;
$$;

ALTER TABLE hr.employee
  DROP COLUMN card_no,
  DROP COLUMN staff_code;

RESET ROLE;
