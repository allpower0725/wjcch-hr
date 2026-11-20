SET LOCAL ROLE hr;

LOCK TABLE hr.department_manager IN ACCESS EXCLUSIVE MODE;

-- Remove the hospital-level acting assignment before restoring the shared slot.
DELETE FROM hr.department_manager
WHERE department_id = 1 AND role = 'acting';

DROP INDEX hr.uq_department_manager_current_head;
CREATE UNIQUE INDEX uq_department_manager_current_head
  ON hr.department_manager (department_id)
  WHERE role IN ('head', 'acting') AND end_date IS NULL;

RESET ROLE;
