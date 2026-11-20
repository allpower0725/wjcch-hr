SET LOCAL ROLE hr;

ALTER TABLE hr.employee ADD COLUMN phone_ext varchar(10);
COMMENT ON COLUMN hr.employee.phone_ext IS '員工院內分機，可共用；以文字保留前導零';

RESET ROLE;
