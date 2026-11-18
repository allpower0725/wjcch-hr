SET LOCAL ROLE hr;
SET LOCAL lock_timeout = '10s';

-- Check again under lock before discarding any recorded ownership periods.
LOCK TABLE hr.employee_device_mapping IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM hr.employee_device_mapping WHERE valid_from IS NOT NULL OR valid_to IS NOT NULL) THEN
    RAISE EXCEPTION 'Recorded device ownership periods must be reviewed before removal';
  END IF;
END;
$$;

CREATE OR REPLACE VIEW hr.v_punch_employee WITH (security_invoker = true) AS
SELECT r.*,
  CASE WHEN r.punched_at >= m.confirmed_at THEN e.employee_id END AS employee_id,
  CASE WHEN r.punched_at >= m.confirmed_at THEN e.employee_no END AS employee_no,
  CASE WHEN r.punched_at >= m.confirmed_at THEN e.name END AS employee_name,
  e.employee_no AS candidate_employee_no, e.name AS candidate_employee_name,
  m.employee_device_mapping_id,
  CASE WHEN m.employee_device_mapping_id IS NULL THEN 'unmatched'
       WHEN r.punched_at < m.confirmed_at THEN 'history_pending'
       ELSE 'matched' END AS association_status
FROM hr.raw_punch r
LEFT JOIN hr.employee_device_mapping m USING (punch_device_id, device_user_no)
LEFT JOIN hr.employee e USING (employee_id);

ALTER TABLE hr.employee_device_mapping
  DROP CONSTRAINT ex_employee_device_mapping_period,
  ADD CONSTRAINT uq_employee_device_mapping_account UNIQUE (punch_device_id, device_user_no),
  DROP COLUMN valid_from,
  DROP COLUMN valid_to,
  DROP COLUMN source_import_row_id,
  DROP COLUMN match_basis;

COMMENT ON TABLE hr.employee_device_mapping IS '員工與卡機帳號的現行對照；同機同號只保留一筆';
COMMENT ON COLUMN hr.raw_punch.device_user_no IS '卡機帳號；與卡機 ID 一起對照員工';
COMMENT ON VIEW hr.v_punch_employee IS '按卡機與帳號配對員工；確認時間以前的打卡只顯示候選員工';
RESET lock_timeout;
RESET ROLE;
