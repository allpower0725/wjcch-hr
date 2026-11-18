SET LOCAL ROLE hr;

ALTER TABLE hr.employee_education DROP COLUMN source_import_row_id;
DROP TABLE hr.personnel_import_row;
DROP TABLE hr.personnel_import_batch;

RESET ROLE;
