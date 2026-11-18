SET LOCAL ROLE hr;

ALTER TABLE hr.department_manager DROP COLUMN source_import_row_id;

RESET ROLE;
