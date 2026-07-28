-- +goose Up
CREATE TABLE pages (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id      uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    url          text NOT NULL,
    path         text NOT NULL,
    title        text,
    meta_desc    text,
    content_hash text NOT NULL,
    markdown     text NOT NULL,
    summary      text,
    summary_hash text,
    http_status  int,
    fetched_at   timestamptz,
    tsv          tsvector GENERATED ALWAYS AS (
                     setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                     setweight(to_tsvector('english', left(markdown, 100000)), 'B')
                 ) STORED,
    UNIQUE (site_id, url)
);

CREATE INDEX pages_tsv_idx ON pages USING gin (tsv);
CREATE INDEX pages_site_path_idx ON pages (site_id, path);

CREATE TABLE crawls (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id       uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    status        text NOT NULL DEFAULT 'queued',
    pages_crawled int NOT NULL DEFAULT 0,
    max_pages     int NOT NULL DEFAULT 50,
    checkpoint    jsonb,
    error         text,
    heartbeat_at  timestamptz,
    started_at    timestamptz,
    finished_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crawls_site_idx ON crawls (site_id, created_at DESC);

-- +goose Down
DROP TABLE crawls;
DROP TABLE pages;
