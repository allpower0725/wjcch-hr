SELECT jsonb_build_object(
  'counts', jsonb_build_object(
    'employees', (SELECT count(*) FROM hr.employee),
    'departments', (SELECT count(*) FROM hr.department WHERE is_active),
    'job_titles', (SELECT count(*) FROM hr.job_title),
    'job_duties', (SELECT count(*) FROM hr.job_duty),
    'employment_types', (SELECT count(*) FROM hr.employment_type),
    'managers', (SELECT count(*) FROM hr.department_manager WHERE end_date IS NULL),
    'education', (SELECT count(*) FROM hr.employee_education),
    'license_types', (SELECT count(*) FROM hr.license_type),
    'licenses', (SELECT count(*) FROM hr.employee_license),
    'device_mappings', (SELECT count(*) FROM hr.employee_device_mapping)),
  'missing_hire_dates', (SELECT count(*) FROM hr.employee WHERE hire_date IS NULL),
  'unknown_genders', (SELECT count(*) FROM hr.employee WHERE gender IS NULL),
  'attendance_exceptions', (SELECT count(*) FROM hr.employee WHERE NOT attendance_required),
  'non_active_employees', (SELECT count(*) FROM hr.employee WHERE employment_status <> 'active'),
  'license_status', (SELECT coalesce(jsonb_object_agg(validity_status, n), '{}'::jsonb)
    FROM (SELECT validity_status, count(*) n FROM hr.v_employee_license GROUP BY validity_status) x),
  'orphan_employee_refs', (SELECT count(*) FROM hr.employee e
    LEFT JOIN hr.department d ON d.department_id = e.department_id
    LEFT JOIN hr.job_title t ON t.job_title_id = e.job_title_id
    LEFT JOIN hr.job_duty j ON j.job_duty_id = e.job_duty_id
    LEFT JOIN hr.employment_type et ON et.employment_type_id = e.employment_type_id
    WHERE d.department_id IS NULL OR t.job_title_id IS NULL OR j.job_duty_id IS NULL OR et.employment_type_id IS NULL)
);
