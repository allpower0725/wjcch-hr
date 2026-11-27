SET LOCAL ROLE hr;
SET LOCAL lock_timeout = '10s';

ALTER TABLE hr.roster_version
  DROP CONSTRAINT roster_version_status_check,
  ADD COLUMN effective_at timestamptz,
  ADD CONSTRAINT roster_version_status_check CHECK (status IN (
    'draft','submitted','withdrawn','returned','rejected','effective','superseded'
  )),
  ADD CONSTRAINT roster_version_effective_time_check CHECK (
    (status IN ('effective','superseded')) = (effective_at IS NOT NULL)
  );

DROP INDEX hr.uq_roster_version_editable_draft;
CREATE UNIQUE INDEX uq_roster_version_open
  ON hr.roster_version (department_id, month_start) WHERE status IN ('draft','submitted');
CREATE UNIQUE INDEX uq_roster_version_effective
  ON hr.roster_version (department_id, month_start) WHERE status = 'effective';

CREATE TABLE hr.approval_policy (
  department_id integer NOT NULL REFERENCES hr.department,
  case_type text NOT NULL CHECK (case_type = 'roster'),
  hospital_action text NOT NULL CHECK (hospital_action IN ('approve','notify')),
  hospital_role text NOT NULL CHECK (hospital_role IN ('head','deputy')),
  updated_by integer NOT NULL REFERENCES hr.employee,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (department_id, case_type)
);

CREATE TABLE hr.roster_approval_case (
  case_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id bigint NOT NULL UNIQUE REFERENCES hr.roster_version,
  submitted_by integer NOT NULL REFERENCES hr.employee,
  submitted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  is_late boolean NOT NULL,
  block_reason text
);

CREATE TABLE hr.roster_approval_step (
  case_id bigint NOT NULL REFERENCES hr.roster_approval_case,
  position integer NOT NULL CHECK (position > 0),
  employee_id integer REFERENCES hr.employee,
  department_ids integer[] NOT NULL CHECK (cardinality(department_ids) > 0),
  hospital_role text CHECK (hospital_role IN ('head','deputy')),
  action text NOT NULL CHECK (action IN ('approve','notify')),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','approved','returned','rejected','notified')),
  PRIMARY KEY (case_id, position),
  CHECK (employee_id IS NOT NULL OR action = 'notify')
);
CREATE INDEX ix_roster_approval_step_employee ON hr.roster_approval_step (employee_id, case_id);

CREATE TABLE hr.roster_approval_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES hr.roster_approval_case,
  position integer,
  actor_id integer NOT NULL REFERENCES hr.employee,
  action text NOT NULL CHECK (action IN ('submit','withdraw','approve','return','reject','effective','notify')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  reason text CHECK (char_length(reason) <= 500),
  FOREIGN KEY (case_id, position) REFERENCES hr.roster_approval_step
);
CREATE INDEX ix_roster_approval_event_case ON hr.roster_approval_event (case_id,event_id);

CREATE TABLE hr.roster_approval_dependency (
  parent_case_id bigint NOT NULL REFERENCES hr.roster_approval_case,
  child_case_id bigint NOT NULL REFERENCES hr.roster_approval_case,
  PRIMARY KEY (parent_case_id, child_case_id),
  CHECK (child_case_id < parent_case_id)
);
CREATE INDEX ix_roster_approval_dependency_child ON hr.roster_approval_dependency (child_case_id);

ALTER TABLE hr.approval_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.roster_approval_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.roster_approval_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.roster_approval_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.roster_approval_dependency ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION hr.roster_approval_error(p_status integer,p_message text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('status',p_status,'error',p_message)
$$;

CREATE FUNCTION hr.roster_approval_path(p_unit integer)
RETURNS TABLE(department_id integer, depth integer)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  WITH RECURSIVE path AS (
    SELECT d.department_id,d.parent_id,0 AS depth,ARRAY[d.department_id] AS visited
    FROM hr.department AS d WHERE d.department_id=p_unit AND d.is_active
    UNION ALL
    SELECT d.department_id,d.parent_id,p.depth+1,p.visited || d.department_id
    FROM path AS p JOIN hr.department AS d ON d.department_id=p.parent_id
    WHERE d.is_active AND NOT d.department_id=ANY(p.visited) AND p.department_id<>1
  ) SELECT department_id,depth FROM path
$$;

CREATE FUNCTION hr.roster_approval_managers()
RETURNS TABLE(department_id integer, employee_id integer, role text)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT m.department_id,m.employee_id,m.role::text
  FROM hr.department_manager AS m JOIN hr.employee AS e USING (employee_id)
  WHERE e.employment_status='active'
    AND ((m.department_id=1 AND m.role IN ('head','deputy')) OR
         (m.department_id<>1 AND m.role IN ('head','acting')))
    AND (m.start_date IS NULL OR m.start_date <= (statement_timestamp() AT TIME ZONE 'Asia/Taipei')::date)
    AND (m.end_date IS NULL OR m.end_date >= (statement_timestamp() AT TIME ZONE 'Asia/Taipei')::date)
$$;

CREATE FUNCTION hr.roster_approval_roster_unit(p_unit integer)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM hr.department AS d JOIN hr.employee AS e USING (department_id)
    WHERE d.department_id=p_unit AND d.is_active AND e.employment_status='active'
  )
$$;

CREATE FUNCTION hr.roster_approval_scope(p_actor integer,p_unit integer)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT hr.roster_approval_roster_unit(p_unit) AND (
    hr.has_system_admin_grant(p_actor)
    OR EXISTS (SELECT 1 FROM hr.employee WHERE employee_id=p_actor AND department_id=p_unit AND employment_status='active')
    OR EXISTS (
      SELECT 1 FROM hr.roster_approval_path(p_unit) AS p
      JOIN hr.roster_approval_managers() AS m USING (department_id) WHERE m.employee_id=p_actor
    )
  )
$$;

CREATE FUNCTION hr.roster_approval_due(p_month date,p_day integer)
RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ((date_trunc('month', p_month::timestamp-interval '1 day')::date
    + least(p_day,extract(day FROM p_month-1)::integer))::timestamp AT TIME ZONE 'Asia/Taipei')
$$;

CREATE FUNCTION hr.roster_approval_route(p_unit integer,p_actor integer)
RETURNS TABLE(sender integer, reason text, hospital_person integer, hospital_role text, hospital_action text, lower_steps jsonb)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  policy hr.approval_policy%ROWTYPE;
  candidates integer;
  nearest record;
BEGIN
  SELECT * INTO policy FROM hr.approval_policy WHERE department_id=p_unit AND case_type='roster';
  hospital_role:=policy.hospital_role;

  IF p_unit=1 AND EXISTS (SELECT 1 FROM hr.roster_approval_managers() AS m WHERE m.department_id=1 AND m.employee_id=p_actor) THEN
    hospital_person:=p_actor;
    SELECT min(m.role) INTO hospital_role FROM hr.roster_approval_managers() AS m
    WHERE m.department_id=1 AND m.employee_id=p_actor;
    candidates:=1;
  ELSE
    SELECT count(DISTINCT m.employee_id),min(m.employee_id) INTO candidates,hospital_person
    FROM hr.roster_approval_managers() AS m WHERE m.department_id=1
      AND (policy.hospital_role IS NULL OR policy.hospital_role=m.role);
    IF candidates<>1 THEN hospital_person:=NULL; END IF;
  END IF;

  SELECT count(*) AS n,min(m.employee_id) AS employee_id INTO nearest
  FROM hr.roster_approval_path(p_unit) AS p JOIN hr.roster_approval_managers() AS m USING(department_id)
  WHERE p.department_id<>1
  GROUP BY p.depth ORDER BY p.depth LIMIT 1;
  IF NOT FOUND THEN sender:=hospital_person;
  ELSIF nearest.n=1 THEN sender:=nearest.employee_id;
  ELSE reason:='最近一層有多位有效主管，需由管理者處理。'; END IF;

  IF NOT EXISTS (SELECT 1 FROM hr.roster_approval_path(p_unit) WHERE department_id=1) THEN
    reason:='組織路徑未連到院級，需由管理者處理。';
  ELSIF EXISTS (
    SELECT 1 FROM hr.roster_approval_path(p_unit) AS p
    JOIN hr.roster_approval_managers() AS m USING(department_id) WHERE p.department_id<>1
    GROUP BY p.department_id HAVING count(*)>1
  ) THEN reason:='有簽核層級存在多位有效主管，需由管理者處理。';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('employee_id',person,'department_ids',ids) ORDER BY level),'[]')
    INTO lower_steps
  FROM (
    SELECT m.employee_id AS person,min(p.depth) AS level,array_agg(p.department_id ORDER BY p.depth) AS ids
    FROM hr.roster_approval_path(p_unit) AS p JOIN hr.roster_approval_managers() AS m USING(department_id)
    WHERE p.department_id<>1 AND m.employee_id IS DISTINCT FROM sender
    GROUP BY m.employee_id
  ) AS grouped;

  hospital_action:=CASE WHEN jsonb_array_length(lower_steps)=0 THEN 'approve' ELSE policy.hospital_action END;
  IF reason IS NULL AND hospital_action IS NULL THEN reason:='院級動作待設定。'; END IF;
  IF reason IS NULL AND hospital_action='approve' AND hospital_person IS NULL THEN
    reason:='院級簽核人待分派，已列入管理者待處理。';
  END IF;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION hr.roster_approval_children(p_unit integer,p_month date)
RETURNS TABLE(department_id integer,name text,case_id bigint)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  WITH RECURSIVE children AS (
    SELECT d.department_id,d.name,ARRAY[p_unit,d.department_id] AS visited
    FROM hr.department AS d WHERE d.parent_id=p_unit AND d.department_id<>p_unit AND d.is_active
    UNION ALL
    SELECT d.department_id,d.name,c.visited || d.department_id
    FROM children AS c JOIN hr.department AS d ON d.parent_id=c.department_id
    WHERE d.is_active AND NOT d.department_id=ANY(c.visited)
  )
  SELECT c.department_id,c.name::text,selected.case_id
  FROM children AS c LEFT JOIN LATERAL (
    SELECT a.case_id FROM hr.roster_version AS v JOIN hr.roster_approval_case AS a USING(version_id)
    WHERE v.department_id=c.department_id AND v.month_start=p_month AND v.status IN ('submitted','effective')
    ORDER BY (v.status='submitted') DESC LIMIT 1
  ) AS selected ON true
  WHERE hr.roster_approval_roster_unit(c.department_id)
$$;

CREATE FUNCTION hr.roster_approval_step_active(p_employee integer,p_departments integer[],p_hospital_role text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT p_employee IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM unnest(p_departments) AS ids(department_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM hr.roster_approval_managers() AS m
      WHERE m.employee_id=p_employee AND m.department_id=ids.department_id
        AND (ids.department_id<>1 OR p_hospital_role IS NULL OR m.role=p_hospital_role)
    )
  )
$$;

CREATE FUNCTION hr.roster_approval_version_issue(p_version bigint)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  v hr.roster_version%ROWTYPE;
  conflict date;
BEGIN
  SELECT * INTO STRICT v FROM hr.roster_version WHERE version_id=p_version;
  IF NOT EXISTS(SELECT 1 FROM hr.roster_day WHERE version_id=p_version) THEN
    RETURN '請先排定至少一筆班次或休假。';
  END IF;
  IF EXISTS (
    SELECT 1 FROM hr.roster_day AS d JOIN hr.employee AS e USING(employee_id)
    WHERE d.version_id=p_version AND (e.department_id IS DISTINCT FROM v.department_id
      OR e.employment_status <> 'active' OR d.work_date<v.month_start OR d.work_date>=v.month_start+interval '1 month')
  ) THEN RETURN '班表含有已不適用的人員或日期，請核對後重送。'; END IF;
  SELECT d.work_date INTO conflict
  FROM hr.roster_day AS d JOIN hr.roster_shift_segment AS s USING(roster_day_id)
  JOIN hr.roster_day AS other ON other.employee_id=d.employee_id AND other.work_date BETWEEN d.work_date-1 AND d.work_date+1
  JOIN hr.roster_version AS ov ON ov.version_id=other.version_id
  JOIN hr.roster_shift_segment AS os ON os.roster_day_id=other.roster_day_id
  WHERE d.version_id=p_version AND ov.status IN ('draft','submitted','effective')
    AND (other.version_id<>p_version OR s.roster_day_id<os.roster_day_id
      OR (s.roster_day_id=os.roster_day_id AND s.segment_no<os.segment_no))
    AND NOT (ov.status='effective' AND ov.department_id=v.department_id AND ov.month_start=v.month_start AND ov.version_id<>p_version)
    AND hr.roster_paid_ranges(d.shift_code,d.work_date,s.starts_at,s.ends_at)
      && hr.roster_paid_ranges(other.shift_code,other.work_date,os.starts_at,os.ends_at)
  LIMIT 1;
  IF FOUND THEN RETURN '班次在 ' || to_char(conflict,'YYYY-MM-DD') || ' 發生重疊，請核對後重送。'; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION hr.roster_approval_can_withdraw(p_actor integer,p_case bigint)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM hr.roster_approval_case AS a JOIN hr.roster_version AS v USING(version_id)
    WHERE a.case_id=p_case AND a.submitted_by=p_actor AND v.status='submitted'
      AND NOT EXISTS (SELECT 1 FROM hr.roster_approval_step WHERE case_id=p_case AND status<>'waiting')
      AND NOT EXISTS (
        SELECT 1 FROM hr.roster_approval_dependency AS dep
        JOIN hr.roster_approval_case AS parent ON parent.case_id=dep.parent_case_id
        JOIN hr.roster_version AS pv ON pv.version_id=parent.version_id
        WHERE dep.child_case_id=p_case AND pv.status IN ('submitted','effective')
      )
  )
$$;

CREATE FUNCTION hr.roster_approval_state(p_actor integer,p_unit integer,p_month date,p_due_day integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  v hr.roster_version%ROWTYPE;
  last_case hr.roster_approval_case%ROWTYPE;
  route record;
  children jsonb;
  due timestamptz;
  sent boolean;
BEGIN
  IF NOT hr.roster_approval_scope(p_actor,p_unit) THEN RETURN hr.roster_approval_error(403,'無法查看這個單位。'); END IF;
  SELECT * INTO v FROM hr.roster_version
  WHERE department_id=p_unit AND month_start=p_month AND status IN ('draft','submitted','effective')
  ORDER BY (status IN ('draft','submitted')) DESC LIMIT 1;
  SELECT a.* INTO last_case FROM hr.roster_approval_case AS a JOIN hr.roster_version AS av USING(version_id)
  WHERE av.department_id=p_unit AND av.month_start=p_month ORDER BY av.version_no DESC LIMIT 1;
  SELECT * INTO route FROM hr.roster_approval_route(p_unit,p_actor);
  SELECT coalesce(jsonb_agg(name ORDER BY department_id),'[]') INTO children
  FROM hr.roster_approval_children(p_unit,p_month) WHERE case_id IS NULL;
  due:=hr.roster_approval_due(p_month,p_due_day);
  sent:=v.status IN ('submitted','effective');
  RETURN jsonb_build_object(
    'versionId',v.version_id::text,'revision',coalesce(v.revision,0),'status',coalesce(v.status,'draft'),
    'caseId',last_case.case_id::text,'late',CASE WHEN sent THEN last_case.is_late ELSE statement_timestamp()>=due END,
    'dueDate',to_char((due AT TIME ZONE 'Asia/Taipei')::date-1,'YYYY-MM-DD'),
    'responsible', (SELECT name FROM hr.employee WHERE employee_id=route.sender),
    'isSubmitter',route.sender IS NOT DISTINCT FROM p_actor,
    'canSubmit',coalesce(v.status,'draft')='draft' AND route.sender IS NOT DISTINCT FROM p_actor
      AND jsonb_array_length(children)=0,
    'canWithdraw',hr.roster_approval_can_withdraw(p_actor,last_case.case_id),
    'canReview',hr.has_system_admin_grant(p_actor) OR EXISTS (
      SELECT 1 FROM hr.roster_approval_managers() AS m WHERE m.employee_id=p_actor
    ),
    'missingUnits',CASE WHEN route.sender IS NOT DISTINCT FROM p_actor AND NOT coalesce(sent,false) THEN children ELSE '[]'::jsonb END,
    'blockReason',CASE WHEN sent THEN last_case.block_reason ELSE route.reason END,
    'lastReturn',(SELECT e.reason FROM hr.roster_approval_event AS e
      WHERE e.case_id=last_case.case_id AND e.action IN ('return','reject') ORDER BY e.event_id DESC LIMIT 1)
  );
END;
$$;

CREATE FUNCTION hr.roster_approval_submit(p_actor integer,p_unit integer,p_month date,p_revision integer,p_due_day integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v hr.roster_version%ROWTYPE;
  route record;
  new_case bigint;
  children record;
  problem text;
  next_position integer;
BEGIN
  SELECT * INTO route FROM hr.roster_approval_route(p_unit,p_actor);
  IF NOT hr.roster_approval_roster_unit(p_unit) OR route.sender IS DISTINCT FROM p_actor THEN
    RETURN hr.roster_approval_error(403,'此單位須由有效責任主管或代理主管送出。');
  END IF;
  SELECT * INTO v FROM hr.roster_version
  WHERE department_id=p_unit AND month_start=p_month AND status='draft' FOR UPDATE;
  IF NOT FOUND OR v.revision IS DISTINCT FROM p_revision THEN
    RETURN hr.roster_approval_error(409,'班表已變更或送出，請重新載入。');
  END IF;
  SELECT c.name INTO children FROM hr.roster_approval_children(p_unit,p_month) AS c WHERE c.case_id IS NULL LIMIT 1;
  IF FOUND THEN RETURN hr.roster_approval_error(409,'下層單位尚未送出：' || children.name); END IF;
  problem:=hr.roster_approval_version_issue(v.version_id);
  IF problem IS NOT NULL THEN RETURN hr.roster_approval_error(422,problem); END IF;

  UPDATE hr.roster_version SET status='submitted' WHERE version_id=v.version_id;
  INSERT INTO hr.roster_approval_case(version_id,submitted_by,is_late,block_reason)
    VALUES (v.version_id,p_actor,statement_timestamp()>=hr.roster_approval_due(p_month,p_due_day),route.reason)
    RETURNING case_id INTO new_case;
  INSERT INTO hr.roster_approval_dependency(parent_case_id,child_case_id)
    SELECT new_case,c.case_id FROM hr.roster_approval_children(p_unit,p_month) AS c;
  INSERT INTO hr.roster_approval_step(case_id,position,employee_id,department_ids,action)
    SELECT new_case,row_number() OVER(ORDER BY ordered.ordinality),lower_step.employee_id,lower_step.department_ids,'approve'
    FROM jsonb_array_elements(route.lower_steps) WITH ORDINALITY AS ordered(step,ordinality)
    CROSS JOIN LATERAL jsonb_to_record(ordered.step) AS lower_step(employee_id integer,department_ids integer[])
    WHERE NOT (route.hospital_action IS NOT DISTINCT FROM 'approve'
      AND lower_step.employee_id IS NOT DISTINCT FROM route.hospital_person);
  IF route.hospital_action='notify' OR (route.hospital_action='approve' AND route.hospital_person IS NOT NULL) THEN
    SELECT coalesce(max(position),0)+1 INTO next_position FROM hr.roster_approval_step WHERE case_id=new_case;
    INSERT INTO hr.roster_approval_step(case_id,position,employee_id,department_ids,hospital_role,action)
      SELECT new_case,next_position,route.hospital_person, ARRAY[1] ||
        CASE WHEN route.hospital_action='approve' THEN coalesce((
          SELECT s.department_ids FROM jsonb_to_recordset(route.lower_steps) AS s(employee_id integer,department_ids integer[])
          WHERE s.employee_id=route.hospital_person
        ),'{}') ELSE '{}' END,
        route.hospital_role,route.hospital_action;
  END IF;
  INSERT INTO hr.roster_approval_event(case_id,actor_id,action) VALUES (new_case,p_actor,'submit');
  RETURN jsonb_build_object('caseId',new_case::text);
END;
$$;

CREATE FUNCTION hr.roster_approval_open_draft(p_version bigint,p_actor integer,p_copy boolean)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v hr.roster_version%ROWTYPE;
  new_version bigint;
BEGIN
  SELECT * INTO STRICT v FROM hr.roster_version WHERE version_id=p_version;
  INSERT INTO hr.roster_version (department_id,month_start,version_no,updated_by_employee_id)
    SELECT v.department_id,v.month_start,max(version_no)+1,p_actor
    FROM hr.roster_version WHERE department_id=v.department_id AND month_start=v.month_start
    RETURNING version_id INTO new_version;
  IF p_copy THEN
    WITH inserted AS (
      INSERT INTO hr.roster_day(version_id,employee_id,work_date,day_kind,shift_code,note)
        SELECT new_version,employee_id,work_date,day_kind,shift_code,note FROM hr.roster_day WHERE version_id=p_version
      RETURNING roster_day_id,employee_id,work_date
    )
    INSERT INTO hr.roster_shift_segment(roster_day_id,segment_no,starts_at,ends_at)
      SELECT i.roster_day_id,s.segment_no,s.starts_at,s.ends_at
      FROM inserted AS i JOIN hr.roster_day AS d USING(employee_id,work_date)
      JOIN hr.roster_shift_segment AS s ON s.roster_day_id=d.roster_day_id WHERE d.version_id=p_version;
  END IF;
END;
$$;

CREATE FUNCTION hr.roster_approval_review(p_actor integer,p_case bigint,p_action text,p_position integer,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  a hr.roster_approval_case%ROWTYPE;
  v hr.roster_version%ROWTYPE;
  step hr.roster_approval_step%ROWTYPE;
  notice hr.roster_approval_step%ROWTYPE;
  last_approval boolean;
  problem text;
BEGIN
  SELECT * INTO a FROM hr.roster_approval_case WHERE case_id=p_case;
  IF NOT FOUND THEN RETURN hr.roster_approval_error(404,'找不到班表簽核案件。'); END IF;
  SELECT * INTO v FROM hr.roster_version WHERE version_id=a.version_id FOR UPDATE;
  IF v.status <> 'submitted' THEN RETURN hr.roster_approval_error(409,'案件已處理，請重新載入。'); END IF;
  IF p_action='withdraw' THEN
    IF NOT hr.roster_approval_can_withdraw(p_actor,p_case) THEN
      RETURN hr.roster_approval_error(409,'案件已有簽核動作、上層引用，或目前身分不可取回。');
    END IF;
    UPDATE hr.roster_version SET status='withdrawn' WHERE version_id=v.version_id;
    PERFORM hr.roster_approval_open_draft(v.version_id,p_actor,true);
    INSERT INTO hr.roster_approval_event(case_id,actor_id,action) VALUES (p_case,p_actor,'withdraw');
    RETURN jsonb_build_object('caseId',p_case::text);
  END IF;

  SELECT * INTO step FROM hr.roster_approval_step
  WHERE case_id=p_case AND action='approve' AND status='waiting' ORDER BY position LIMIT 1;
  IF NOT FOUND OR step.position IS DISTINCT FROM p_position THEN
    RETURN hr.roster_approval_error(409,'目前簽核關卡已變更。');
  END IF;
  IF step.employee_id IS DISTINCT FROM p_actor OR NOT hr.roster_approval_step_active(step.employee_id,step.department_ids,step.hospital_role) THEN
    RETURN hr.roster_approval_error(403,'目前身分不可執行此關簽核。');
  END IF;
  IF a.block_reason IS NOT NULL THEN RETURN hr.roster_approval_error(409,a.block_reason); END IF;
  IF p_action IN ('return','reject') THEN
    IF coalesce(char_length(p_reason),0) NOT BETWEEN 1 AND 500 THEN
      RETURN hr.roster_approval_error(422,'請填寫處理原因，最多 500 字。');
    END IF;
    UPDATE hr.roster_approval_step SET status=CASE WHEN p_action='return' THEN 'returned' ELSE 'rejected' END
      WHERE case_id=p_case AND position=step.position;
    UPDATE hr.roster_version SET status=CASE WHEN p_action='return' THEN 'returned' ELSE 'rejected' END WHERE version_id=v.version_id;
    PERFORM hr.roster_approval_open_draft(v.version_id,p_actor,p_action='return');
    INSERT INTO hr.roster_approval_event(case_id,position,actor_id,action,reason) VALUES(p_case,step.position,p_actor,p_action,p_reason);
    RETURN jsonb_build_object('caseId',p_case::text);
  END IF;

  IF EXISTS (
    SELECT 1 FROM hr.roster_approval_dependency AS d
    JOIN hr.roster_approval_case AS c ON c.case_id=d.child_case_id JOIN hr.roster_version AS cv USING(version_id)
    WHERE d.parent_case_id=p_case AND cv.status NOT IN ('submitted','effective')
  ) THEN RETURN hr.roster_approval_error(409,'下層班表已退回或失效，請退回本案並重新送出。'); END IF;
  last_approval:=NOT EXISTS (SELECT 1 FROM hr.roster_approval_step WHERE case_id=p_case
    AND action='approve' AND status='waiting' AND position>step.position);
  IF last_approval THEN
    IF EXISTS (
      SELECT 1 FROM hr.roster_approval_dependency AS d JOIN hr.roster_approval_case AS c ON c.case_id=d.child_case_id
      JOIN hr.roster_version AS cv USING(version_id) WHERE d.parent_case_id=p_case AND cv.status<>'effective'
    ) THEN RETURN hr.roster_approval_error(409,'下層班表尚待生效，請完成下層簽核後再處理。'); END IF;
    problem:=hr.roster_approval_version_issue(v.version_id);
    IF problem IS NOT NULL THEN RETURN hr.roster_approval_error(422,problem); END IF;
  END IF;

  UPDATE hr.roster_approval_step SET status='approved' WHERE case_id=p_case AND position=step.position;
  INSERT INTO hr.roster_approval_event(case_id,position,actor_id,action,reason) VALUES (p_case,step.position,p_actor,'approve',p_reason);
  IF last_approval THEN
    UPDATE hr.roster_version SET status='superseded' WHERE department_id=v.department_id AND month_start=v.month_start AND status='effective';
    UPDATE hr.roster_version SET status='effective',effective_at=statement_timestamp() WHERE version_id=v.version_id;
    INSERT INTO hr.roster_approval_event(case_id,actor_id,action) VALUES(p_case,p_actor,'effective');
    SELECT * INTO notice FROM hr.roster_approval_step WHERE case_id=p_case AND action='notify';
    IF FOUND THEN
      IF hr.roster_approval_step_active(notice.employee_id,notice.department_ids,notice.hospital_role) THEN
        UPDATE hr.roster_approval_step SET status='notified' WHERE case_id=p_case AND position=notice.position;
        INSERT INTO hr.roster_approval_event(case_id,position,actor_id,action) VALUES (p_case,notice.position,p_actor,'notify');
      ELSE
        UPDATE hr.roster_approval_case SET block_reason='院級知會待處理，班表已生效。' WHERE case_id=p_case;
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('caseId',p_case::text,'effective',last_approval);
END;
$$;

CREATE FUNCTION hr.roster_approval_card(p_actor integer,p_case bigint)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'caseId',a.case_id::text,'unit',d.name,'month',to_char(v.month_start,'YYYY-MM'),
    'version',v.version_no,'status',v.status,'submittedAt',a.submitted_at,'submittedBy',sender.name,'late',a.is_late,
    'position',step.position,'assignee',reviewer.name,
    'canReview',v.status='submitted' AND a.block_reason IS NULL AND step.employee_id=p_actor AND eligibility.active,
    'canWithdraw',hr.roster_approval_can_withdraw(p_actor,a.case_id),
    'notice',EXISTS(SELECT 1 FROM hr.roster_approval_step AS n WHERE n.case_id=a.case_id
       AND n.employee_id=p_actor AND n.action='notify' AND n.status='notified'),
    'blockReason',coalesce(a.block_reason,CASE
      WHEN v.status='submitted' AND step.position IS NOT NULL AND NOT eligibility.active
        THEN '目前簽核人已無有效指派，已列入管理者待處理。'
      WHEN v.status='submitted' AND EXISTS (
        SELECT 1 FROM hr.roster_approval_dependency AS dep
        JOIN hr.roster_approval_case AS child ON child.case_id=dep.child_case_id
        JOIN hr.roster_version AS cv ON cv.version_id=child.version_id
        WHERE dep.parent_case_id=a.case_id AND cv.status NOT IN ('submitted','effective')
      ) THEN '下層班表需重新送出，請退回本案。' END)
  )
  FROM hr.roster_approval_case AS a JOIN hr.roster_version AS v USING(version_id)
  JOIN hr.department AS d USING(department_id) JOIN hr.employee AS sender ON sender.employee_id=a.submitted_by
  LEFT JOIN LATERAL (
    SELECT s.* FROM hr.roster_approval_step AS s
    WHERE s.case_id=a.case_id AND s.status='waiting' AND s.action='approve' ORDER BY s.position LIMIT 1
  ) AS step ON true
  LEFT JOIN hr.employee AS reviewer ON reviewer.employee_id=step.employee_id
  CROSS JOIN LATERAL (SELECT hr.roster_approval_step_active(step.employee_id,step.department_ids,step.hospital_role) AS active) AS eligibility
  WHERE a.case_id=p_case
$$;

CREATE FUNCTION hr.roster_approval_queue(p_actor integer)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  WITH privileges AS (
    SELECT hr.has_system_admin_grant(p_actor) AS admin,
      EXISTS(SELECT 1 FROM hr.roster_approval_managers() AS m WHERE m.employee_id=p_actor) AS manager
  ), cards AS (
    SELECT hr.roster_approval_card(p_actor,a.case_id) AS body,a.submitted_at
    FROM hr.roster_approval_case AS a JOIN hr.roster_version AS v USING(version_id) CROSS JOIN privileges
    WHERE (v.status='submitted' AND EXISTS (
      SELECT 1 FROM hr.roster_approval_step AS s WHERE s.case_id=a.case_id AND s.employee_id=p_actor
        AND s.action='approve' AND s.status='waiting' AND s.position=(
          SELECT min(current_step.position) FROM hr.roster_approval_step AS current_step
          WHERE current_step.case_id=a.case_id AND current_step.action='approve' AND current_step.status='waiting'
        )
    )) OR (v.status='effective' AND EXISTS (
      SELECT 1 FROM hr.roster_approval_step AS s WHERE s.case_id=a.case_id AND s.employee_id=p_actor
        AND s.action='notify' AND s.status='notified'
    )) OR (privileges.admin AND (v.status='submitted' OR (v.status='effective' AND a.block_reason IS NOT NULL)))
    ORDER BY (v.status='submitted') DESC,a.submitted_at DESC LIMIT 100
  )
  SELECT jsonb_build_object(
    'admin',privileges.admin,'manager',privileges.manager,
    'cards',coalesce((SELECT jsonb_agg(body ORDER BY (body->>'status'='submitted') DESC,submitted_at DESC) FROM cards),'[]'),
    'policies',CASE WHEN privileges.admin THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object('unitId',d.department_id,'unit',d.name,
        'hospitalAction',p.hospital_action,'hospitalRole',p.hospital_role) ORDER BY d.sort_order,d.department_id)
      FROM hr.department AS d LEFT JOIN hr.approval_policy AS p ON p.department_id=d.department_id AND p.case_type='roster'
      WHERE d.is_active AND hr.roster_approval_roster_unit(d.department_id)
    ),'[]') ELSE '[]' END
  ) FROM privileges
$$;

CREATE FUNCTION hr.roster_approval_detail(p_actor integer,p_case bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  a hr.roster_approval_case%ROWTYPE;
BEGIN
  SELECT * INTO a FROM hr.roster_approval_case WHERE case_id=p_case;
  IF NOT FOUND OR NOT (hr.has_system_admin_grant(p_actor) OR a.submitted_by=p_actor OR EXISTS (
    SELECT 1 FROM hr.roster_approval_step AS s WHERE s.case_id=p_case AND s.employee_id=p_actor
      AND (s.action='approve' OR s.status='notified')
  )) THEN RETURN hr.roster_approval_error(404,'找不到可查看的班表簽核案件。'); END IF;
  RETURN hr.roster_approval_card(p_actor,p_case) || jsonb_build_object(
    'steps',coalesce((
      SELECT jsonb_agg(jsonb_build_object('position',s.position,'employee',e.name,'action',s.action,'status',s.status,
        'units',(SELECT jsonb_agg(d.name ORDER BY units.ordinality)
          FROM unnest(s.department_ids) WITH ORDINALITY AS units(id,ordinality)
          JOIN hr.department AS d ON d.department_id=units.id)) ORDER BY s.position)
      FROM hr.roster_approval_step AS s LEFT JOIN hr.employee AS e ON e.employee_id=s.employee_id WHERE s.case_id=p_case
    ),'[]'),
    'events',coalesce((
      SELECT jsonb_agg(jsonb_build_object('id',ev.event_id::text,'actor',e.name,'action',ev.action,
        'at',ev.created_at,'reason',ev.reason) ORDER BY ev.event_id)
      FROM hr.roster_approval_event AS ev JOIN hr.employee AS e ON e.employee_id=ev.actor_id WHERE ev.case_id=p_case
    ),'[]'),
    'days',coalesce((
      SELECT jsonb_agg(jsonb_build_object('id',d.roster_day_id::text,'employee',e.name,
        'date',to_char(d.work_date,'YYYY-MM-DD'),'shift',coalesce(t.name,CASE WHEN d.day_kind='work' THEN '自訂工時' ELSE '休息日' END),'note',d.note,
        'times',coalesce((
          SELECT jsonb_agg(jsonb_build_array(
            to_char(s.starts_at AT TIME ZONE 'Asia/Taipei','MM/DD HH24:MI'),
            to_char(s.ends_at AT TIME ZONE 'Asia/Taipei','MM/DD HH24:MI')) ORDER BY s.segment_no)
          FROM hr.roster_shift_segment AS s WHERE s.roster_day_id=d.roster_day_id
        ),'[]')) ORDER BY d.work_date,e.employee_no)
      FROM hr.roster_day AS d JOIN hr.employee AS e USING(employee_id)
      LEFT JOIN hr.roster_shift_type AS t ON t.code=d.shift_code WHERE d.version_id=a.version_id
    ),'[]')
  );
END;
$$;

CREATE FUNCTION hr.roster_approval_request(p_actor integer,p_request jsonb,p_due_day integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  operation text := p_request->>'action';
  unit_id integer;
  month_start date;
  approval_id bigint;
  reason text := nullif(btrim(p_request->>'reason'),'');
BEGIN
  IF p_actor IS NULL THEN RETURN hr.roster_approval_error(401,'請重新登入。'); END IF;
  IF p_due_day IS NULL OR p_due_day NOT BETWEEN 1 AND 31 THEN RETURN hr.roster_approval_error(503,'班表截止日設定有誤。'); END IF;
  IF operation IN ('state','submit','policy') THEN unit_id:=(p_request->>'unitId')::integer; END IF;
  IF operation IN ('state','submit') THEN
    month_start:=(p_request->>'month')||'-01';
    IF month_start IS NULL OR month_start NOT BETWEEN DATE '1000-01-01' AND DATE '9999-12-01' THEN
      RETURN hr.roster_approval_error(400,'請檢查班表月份。');
    END IF;
  END IF;
  IF operation IN ('detail','withdraw','approve','return','reject') THEN approval_id:=(p_request->>'caseId')::bigint; END IF;
  IF operation='state' THEN RETURN hr.roster_approval_state(p_actor,unit_id,month_start,p_due_day); END IF;
  IF operation='queue' THEN RETURN hr.roster_approval_queue(p_actor); END IF;
  IF operation='detail' THEN RETURN hr.roster_approval_detail(p_actor,approval_id); END IF;

  IF NOT EXISTS(SELECT 1 FROM hr.employee WHERE employee_id=p_actor AND employment_status='active') THEN
    RETURN hr.roster_approval_error(403,'目前身分無法處理班表簽核。');
  END IF;
  -- Writers take the matching shared lock so review always sees a consistent draft and dependency set.
  PERFORM pg_advisory_xact_lock(8292,1);
  IF operation='submit' THEN
    RETURN hr.roster_approval_submit(p_actor,unit_id,month_start,(p_request->>'revision')::integer,p_due_day);
  END IF;
  IF operation IN ('withdraw','approve','return','reject') THEN
    IF char_length(reason)>500 THEN RETURN hr.roster_approval_error(422,'處理原因最多 500 字。'); END IF;
    RETURN hr.roster_approval_review(p_actor,approval_id,operation,(p_request->>'position')::integer,reason);
  END IF;
  IF operation='policy' AND hr.has_system_admin_grant(p_actor) AND hr.roster_approval_roster_unit(unit_id)
    AND p_request->>'hospitalAction' IN ('approve','notify') AND p_request->>'hospitalRole' IN ('head','deputy') THEN
    INSERT INTO hr.approval_policy(department_id,case_type,hospital_action,hospital_role,updated_by)
      VALUES (unit_id,'roster',p_request->>'hospitalAction',p_request->>'hospitalRole',p_actor)
    ON CONFLICT (department_id,case_type) DO UPDATE SET
      hospital_action=excluded.hospital_action,hospital_role=excluded.hospital_role,updated_by=p_actor,updated_at=statement_timestamp();
    RETURN jsonb_build_object('saved',true);
  END IF;
  RETURN hr.roster_approval_error(403,'目前身分不可執行此作業。');
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN
  RETURN hr.roster_approval_error(400,'班表簽核資料格式有誤。');
END;
$$;

ALTER FUNCTION hr.roster_draft_save(integer,integer,integer,date,integer,date[],text,integer[],integer[],text,text,boolean)
  RENAME TO roster_draft_save_impl;

CREATE FUNCTION hr.roster_draft_save(
  p_viewer_id integer,p_unit_id integer,p_employee_id integer,p_month date,
  p_revision integer,p_dates date[],p_kind text,p_starts integer[],p_ends integer[],p_code text,p_note text,p_legacy boolean
)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(8292,1);
  IF EXISTS (
    SELECT 1 FROM hr.roster_version WHERE department_id=p_unit_id AND month_start=p_month AND status IN ('submitted','effective')
  ) AND NOT EXISTS (
    SELECT 1 FROM hr.roster_version WHERE department_id=p_unit_id AND month_start=p_month AND status='draft'
  ) THEN RETURN hr.roster_approval_error(409,'班表已送出或生效，請重新載入。'); END IF;
  RETURN hr.roster_draft_save_impl(p_viewer_id,p_unit_id,p_employee_id,p_month,p_revision,p_dates,p_kind,p_starts,p_ends,p_code,p_note,p_legacy);
END;
$$;

DO $permissions$
DECLARE
  principal name;
  principals text := 'PUBLIC';
  functions text;
BEGIN
  FOR principal IN SELECT rolname FROM pg_roles WHERE rolname IN (
    'hr_collector','anon','authenticated','service_role','hr_line_web_test','hr_line_web_tunnel','hr_web_pilot'
  ) LOOP
    principals:=principals || ', ' || quote_ident(principal);
  END LOOP;
  EXECUTE 'REVOKE ALL ON hr.approval_policy, hr.roster_approval_case, hr.roster_approval_step, '
    'hr.roster_approval_event, hr.roster_approval_dependency FROM ' || principals;
  EXECUTE 'REVOKE ALL ON SEQUENCE hr.roster_approval_case_case_id_seq, hr.roster_approval_event_event_id_seq FROM ' || principals;
  SELECT string_agg('hr.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    INTO functions FROM pg_proc AS p WHERE p.pronamespace='hr'::regnamespace AND
      (starts_with(p.proname,'roster_approval_') OR p.proname IN ('roster_draft_save','roster_draft_save_impl'));
  EXECUTE 'REVOKE ALL ON FUNCTION ' || functions || ' FROM ' || principals;
END;
$permissions$;

RESET ROLE;
