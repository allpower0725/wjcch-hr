SET LOCAL ROLE hr;
SET LOCAL lock_timeout = '10s';

CREATE TABLE hr.employee_line_binding (
  binding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id integer NOT NULL REFERENCES hr.employee(employee_id) ON DELETE RESTRICT,
  provider_id text NOT NULL CHECK (provider_id <> '' AND provider_id = btrim(provider_id)),
  line_user_id text NOT NULL CHECK (line_user_id <> '' AND line_user_id = btrim(line_user_id)),
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revoked_by_employee_id integer REFERENCES hr.employee(employee_id) ON DELETE RESTRICT,
  CHECK ((revoked_at IS NULL) = (revoked_by_employee_id IS NULL)),
  CHECK (revoked_at >= bound_at)
);

CREATE UNIQUE INDEX uq_employee_line_binding_active_employee
  ON hr.employee_line_binding(employee_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX uq_employee_line_binding_active_line
  ON hr.employee_line_binding(provider_id, line_user_id) WHERE revoked_at IS NULL;
CREATE INDEX ix_employee_line_binding_employee_history ON hr.employee_line_binding(employee_id);

CREATE TABLE hr.line_binding_window (
  provider_id text NOT NULL CHECK (provider_id <> '' AND provider_id = btrim(provider_id)),
  line_user_id text NOT NULL CHECK (line_user_id <> '' AND line_user_id = btrim(line_user_id)),
  started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  failure_count smallint NOT NULL DEFAULT 0 CHECK (failure_count BETWEEN 0 AND 5),
  PRIMARY KEY (provider_id, line_user_id),
  CHECK (expires_at - started_at = interval '15 minutes')
);

CREATE TABLE hr.line_login_session (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  binding_id uuid REFERENCES hr.employee_line_binding(binding_id) ON DELETE RESTRICT,
  pending_provider_id text,
  pending_line_user_id text,
  pending_window_started_at timestamptz,
  matched_employee_id integer REFERENCES hr.employee(employee_id) ON DELETE RESTRICT,
  CHECK (
    (binding_id IS NULL AND pending_provider_id IS NOT NULL AND pending_line_user_id IS NOT NULL
      AND pending_window_started_at IS NOT NULL AND created_at >= pending_window_started_at
      AND expires_at - pending_window_started_at = interval '15 minutes')
    OR (binding_id IS NOT NULL AND pending_provider_id IS NULL AND pending_line_user_id IS NULL
      AND pending_window_started_at IS NULL AND matched_employee_id IS NULL)
  )
);
CREATE INDEX ix_line_login_session_binding ON hr.line_login_session(binding_id) WHERE binding_id IS NOT NULL;
CREATE INDEX ix_line_login_session_expires ON hr.line_login_session(expires_at);

ALTER TABLE hr.employee_line_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.line_binding_window ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.line_login_session ENABLE ROW LEVEL SECURITY;

-- Call only after the web server verifies the LINE credential and derives its provider/subject.
CREATE FUNCTION hr.begin_line_login(p_provider_id text, p_line_user_id text, p_token_hash bytea)
RETURNS TABLE (outcome text, deadline timestamptz, attempts_remaining integer)
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v_binding_id uuid;
  v_eligible boolean;
  v_now timestamptz;
  v_window hr.line_binding_window%ROWTYPE;
BEGIN
  SELECT b.binding_id, e.employment_status IN ('active', 'on_leave')
  INTO v_binding_id, v_eligible
  FROM hr.employee_line_binding AS b
  JOIN hr.employee AS e USING (employee_id)
  WHERE b.provider_id = p_provider_id AND b.line_user_id = p_line_user_id AND b.revoked_at IS NULL;

  v_now := clock_timestamp();
  IF v_binding_id IS NOT NULL THEN
    IF NOT v_eligible THEN
      RETURN QUERY SELECT 'ineligible'::text, NULL::timestamptz, NULL::integer;
      RETURN;
    END IF;
    INSERT INTO hr.line_login_session(token_hash, created_at, expires_at, binding_id)
    VALUES (p_token_hash, v_now, v_now + interval '4 hours', v_binding_id);
    RETURN QUERY SELECT 'authenticated'::text, v_now + interval '4 hours', NULL::integer;
    RETURN;
  END IF;

  INSERT INTO hr.line_binding_window(provider_id, line_user_id, started_at, expires_at)
  VALUES (p_provider_id, p_line_user_id, v_now, v_now + interval '15 minutes')
  ON CONFLICT (provider_id, line_user_id) DO NOTHING;

  SELECT w.* INTO STRICT v_window
  FROM hr.line_binding_window AS w
  WHERE w.provider_id = p_provider_id AND w.line_user_id = p_line_user_id
  FOR UPDATE;

  v_now := clock_timestamp();
  IF v_window.expires_at <= v_now THEN
    UPDATE hr.line_binding_window AS w
    SET started_at = v_now, expires_at = v_now + interval '15 minutes', failure_count = 0
    WHERE w.provider_id = p_provider_id AND w.line_user_id = p_line_user_id
    RETURNING w.* INTO v_window;
  END IF;
  IF v_window.failure_count = 5 THEN
    RETURN QUERY SELECT 'locked'::text, v_window.expires_at, 0;
    RETURN;
  END IF;

  INSERT INTO hr.line_login_session(token_hash, created_at, expires_at,
    pending_provider_id, pending_line_user_id, pending_window_started_at)
  VALUES (p_token_hash, v_now, v_window.expires_at,
    p_provider_id, p_line_user_id, v_window.started_at);
  RETURN QUERY SELECT 'binding_required'::text, v_window.expires_at, 5 - v_window.failure_count;
END;
$$;

CREATE FUNCTION hr.verify_line_employee(p_token_hash bytea, p_national_id text, p_birth_date date)
RETURNS TABLE (outcome text, deadline timestamptz, attempts_remaining integer)
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v_session hr.line_login_session%ROWTYPE;
  v_window hr.line_binding_window%ROWTYPE;
  v_employee_id integer;
BEGIN
  SELECT s.* INTO v_session FROM hr.line_login_session AS s
  WHERE s.token_hash = p_token_hash AND s.binding_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'expired'::text, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;

  SELECT w.* INTO v_window FROM hr.line_binding_window AS w
  WHERE w.provider_id = v_session.pending_provider_id AND w.line_user_id = v_session.pending_line_user_id
    AND w.started_at = v_session.pending_window_started_at FOR UPDATE;
  IF NOT FOUND OR v_window.expires_at <= clock_timestamp() THEN
    RETURN QUERY SELECT 'expired'::text, v_session.expires_at, NULL::integer;
    RETURN;
  END IF;
  IF v_window.failure_count = 5 THEN
    RETURN QUERY SELECT 'locked'::text, v_window.expires_at, 0;
    RETURN;
  END IF;

  SELECT e.employee_id INTO v_employee_id
  FROM hr.employee AS e
  WHERE e.national_id = upper(btrim(p_national_id)) AND e.birth_date = p_birth_date
    AND e.employment_status IN ('active', 'on_leave');

  UPDATE hr.line_login_session SET matched_employee_id = v_employee_id WHERE token_hash = p_token_hash;
  IF v_employee_id IS NOT NULL THEN
    RETURN QUERY SELECT 'matched'::text, v_window.expires_at, 5 - v_window.failure_count;
    RETURN;
  END IF;

  UPDATE hr.line_binding_window AS w SET failure_count = w.failure_count + 1
  WHERE w.provider_id = v_window.provider_id AND w.line_user_id = v_window.line_user_id
  RETURNING w.failure_count INTO v_window.failure_count;
  RETURN QUERY SELECT (CASE WHEN v_window.failure_count = 5 THEN 'locked' ELSE 'mismatch' END)::text,
    v_window.expires_at, 5 - v_window.failure_count;
END;
$$;

CREATE FUNCTION hr.confirm_line_binding(p_pending_hash bytea, p_login_hash bytea)
RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v_session hr.line_login_session%ROWTYPE;
  v_window hr.line_binding_window%ROWTYPE;
  v_binding_id uuid;
  v_employment_status text;
  v_now timestamptz;
BEGIN
  SELECT s.* INTO v_session FROM hr.line_login_session AS s
  WHERE s.token_hash = p_pending_hash AND s.binding_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'expired';
  END IF;

  SELECT w.* INTO v_window FROM hr.line_binding_window AS w
  WHERE w.provider_id = v_session.pending_provider_id AND w.line_user_id = v_session.pending_line_user_id
    AND w.started_at = v_session.pending_window_started_at FOR UPDATE;
  IF NOT FOUND OR v_window.expires_at <= clock_timestamp() THEN
    RETURN 'expired';
  END IF;
  IF v_window.failure_count = 5 THEN
    RETURN 'locked';
  END IF;
  IF v_session.matched_employee_id IS NULL THEN
    RETURN 'match_required';
  END IF;

  -- Serialize competing confirmations for the same employee and recheck current employment.
  SELECT e.employment_status INTO STRICT v_employment_status FROM hr.employee AS e
  WHERE e.employee_id = v_session.matched_employee_id FOR NO KEY UPDATE;
  v_now := clock_timestamp();
  IF v_window.expires_at <= v_now THEN
    RETURN 'expired';
  END IF;
  IF v_employment_status NOT IN ('active', 'on_leave') THEN
    RETURN 'ineligible';
  END IF;

  INSERT INTO hr.employee_line_binding(employee_id, provider_id, line_user_id, bound_at)
  VALUES (v_session.matched_employee_id, v_window.provider_id, v_window.line_user_id, v_now)
  ON CONFLICT DO NOTHING RETURNING binding_id INTO v_binding_id;
  IF v_binding_id IS NULL THEN
    RETURN 'binding_conflict';
  END IF;

  -- Insert before deleting the pending row so a distinct token hash is required.
  INSERT INTO hr.line_login_session(token_hash, created_at, expires_at, binding_id)
  VALUES (p_login_hash, v_now, v_now + interval '4 hours', v_binding_id);
  DELETE FROM hr.line_login_session WHERE token_hash = p_pending_hash;
  RETURN 'authenticated';
END;
$$;

CREATE FUNCTION hr.line_login_identity(p_token_hash bytea)
RETURNS TABLE (employee_id integer, employee_no varchar(10))
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT e.employee_id, e.employee_no
  FROM hr.line_login_session AS s
  JOIN hr.employee_line_binding AS b USING (binding_id)
  JOIN hr.employee AS e USING (employee_id)
  WHERE s.token_hash = p_token_hash AND s.expires_at > statement_timestamp()
    AND b.revoked_at IS NULL AND e.employment_status IN ('active', 'on_leave');
$$;

DO $privileges$
DECLARE
  principals text := 'PUBLIC, hr_collector';
  api_role text;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    principals := principals || ', ' || quote_ident(api_role);
  END LOOP;
  EXECUTE 'REVOKE ALL ON hr.employee_line_binding, hr.line_binding_window, hr.line_login_session FROM ' || principals;
  EXECUTE 'REVOKE ALL ON FUNCTION hr.begin_line_login(text, text, bytea), '
    'hr.verify_line_employee(bytea, text, date), hr.confirm_line_binding(bytea, bytea), '
    'hr.line_login_identity(bytea) FROM ' || principals;
END;
$privileges$;

RESET ROLE;
