-- 0001: users and site ownership (auth, domain verification, llms.txt).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider    text NOT NULL,
    provider_id text NOT NULL,
    email       text NOT NULL,
    name        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_id)
);

CREATE TABLE sites (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain                text NOT NULL UNIQUE,
    slug                  text NOT NULL UNIQUE,
    verification_token    text NOT NULL,
    verification_method   text,
    verified_at           timestamptz,
    llms_txt              text,
    llms_txt_generated_at timestamptz,
    settings              jsonb NOT NULL DEFAULT '{}',
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sites_user_idx ON sites (user_id);
