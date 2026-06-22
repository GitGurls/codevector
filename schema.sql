

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Needed for gen_random_uuid() on some Postgres versions / Neon images.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Powers: "give me the next page of ALL products, newest first"
CREATE INDEX IF NOT EXISTS idx_products_created_id
    ON products (created_at DESC, id DESC);

-- Powers: "give me the next page of products IN CATEGORY X, newest first"
CREATE INDEX IF NOT EXISTS idx_products_category_created_id
    ON products (category, created_at DESC, id DESC);

-- Lets the UI populate a category filter dropdown quickly.
CREATE INDEX IF NOT EXISTS idx_products_category
    ON products (category);
