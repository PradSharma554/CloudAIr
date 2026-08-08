-- 0003: agent request analytics and rate limit rules.

CREATE TABLE rate_limit_rules (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id      uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    subject_type text NOT NULL,
    subject      text NOT NULL,
    rpm          int NOT NULL,
    burst        int NOT NULL DEFAULT 10,
    UNIQUE (site_id, subject_type, subject)
);

CREATE TABLE agent_requests (
    id          bigserial PRIMARY KEY,
    site_id     uuid NOT NULL,
    ts          timestamptz NOT NULL DEFAULT now(),
    agent_class text NOT NULL,
    agent_name  text,
    kind        text NOT NULL,
    tool_name   text,
    path        text,
    status_code int,
    latency_ms  int,
    user_agent  text
);

CREATE INDEX agent_requests_site_ts_idx ON agent_requests (site_id, ts DESC);

CREATE TABLE agent_requests_daily (
    site_id       uuid NOT NULL,
    day           date NOT NULL,
    agent_class   text NOT NULL,
    agent_name    text NOT NULL DEFAULT '',
    kind          text NOT NULL,
    request_count int NOT NULL,
    PRIMARY KEY (site_id, day, agent_class, agent_name, kind)
);
