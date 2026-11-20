SET LOCAL ROLE hr;

DROP INDEX hr.uq_department_manager_current_head;
CREATE UNIQUE INDEX uq_department_manager_current_head
  ON hr.department_manager (department_id)
  WHERE role = 'head' AND end_date IS NULL;

RESET ROLE;
