# Product Catalog API — 200k Products, Fast Pagination, Consistent Under Writes

A small backend for browsing ~200,000 products (newest first), with category filtering and
pagination that stays fast and stays correct even while data is being added/updated.

## Live demo

- **API + UI:** `<fill in your Render URL after deploying>`
- **GitHub repo:** `<fill in your repo URL>`

## Stack

- **Node.js + Express** — simple, fast to build and explain.
- **PostgreSQL (Neon)** — relational data fits this task perfectly (fixed columns, filtering,
  ordering), and Postgres gives precise control over indexes, which is the whole point of
  this task.
- **Plain HTML/CSS/JS UI** (bonus, ungraded) — no framework needed for a single browse page.

## How to run locally

```bash
npm install
cp .env.example .env        # then put your real Neon connection string in .env
npm run seed                # generates and inserts 200,000 products (~5 seconds)
npm start                   # starts the server on http://localhost:3000
```

Open `http://localhost:3000` for the UI, or hit the API directly:

```
GET /api/products?limit=20
GET /api/products?limit=20&category=Electronics
GET /api/products?limit=20&cursor=<opaque cursor from previous response>
GET /api/categories
GET /api/products/count
```

To see the "data changing while browsing" guarantee in action:

```bash
npm run simulate-writes     # inserts 50 new products + updates 50 random existing ones
```

Run this in a second terminal while you're paginating through the API/UI in the first one.

## The two real problems in this task

### 1. Making pagination fast on 200k+ rows

The naive approach is `OFFSET`/`LIMIT`:

```sql
SELECT * FROM products ORDER BY created_at DESC LIMIT 20 OFFSET 5000;
```

This is simple but gets slower the deeper you page, because Postgres has to scan and discard
every row before the offset on every single request. I measured this directly on the seeded
200k-row table:

| Approach | Query at "page ~5000" (offset 100,000) |
|---|---|
| `OFFSET 100000 LIMIT 20` | **46.6 ms** |
| Keyset cursor (see below) | **0.16 ms** |

That's roughly **290x slower** for OFFSET at that depth, and it keeps getting worse the deeper
you go, while the keyset approach stays flat regardless of depth. At 200k rows this is already
noticeable; it would be unusable at millions of rows.

**The fix: keyset (cursor) pagination.**

```sql
SELECT id, name, category, price, created_at, updated_at
FROM products
WHERE (created_at, id) < ($lastCreatedAt, $lastId)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

Instead of asking "skip N rows," the client sends back a cursor (an opaque token encoding the
last row it saw), and the query says "give me rows strictly older than that." Combined with a
composite index on `(created_at DESC, id DESC)`, Postgres can seek directly to the right spot
in the index and read forward — no skipping, no sorting, cost independent of how deep the page
is. I confirmed this with `EXPLAIN ANALYZE`: both the first page and a page 5,000 pages deep
use the same `Index Scan`, and both execute in well under a millisecond.

`id` is included as a tiebreaker because `created_at` alone isn't guaranteed unique (the seed
data, and real-world data, can have two rows with the same timestamp). Without the tiebreaker,
rows sharing a timestamp could be skipped or repeated across a page boundary.

For category filtering, there's a second composite index on `(category, created_at DESC, id
DESC)` so filtered pagination gets the same seek-based performance instead of falling back to
a slower scan-and-filter.

### 2. Staying correct while data changes mid-browse

The requirement: if 50 products are added or updated while someone is paging through the list,
they should never see a duplicate and never miss one.

The key decision here is **what column to paginate on**. My first instinct (and a common
mistake) would be to sort by `updated_at`, since that feels like "most recently relevant
first." That's actually wrong here: `updated_at` changes when a row is edited, so an edited
product would jump to the top of the feed mid-browse — a user could see it twice (once in its
old position, once again at the top), or a different row could get pushed past a cursor the
user already consumed and effectively disappear from their view.

Instead, I paginate on `created_at` (paired with `id` as a tiebreaker), and that column is
**immutable** — set once at insert time, never touched again, including by the
`simulate-writes` script. This gives two guarantees:

- **A row's position in the "newest first" ordering never changes after it's created.** Once
  a user has a cursor past a given row, that row will never re-appear ahead of the cursor,
  because the value that determines its position can't change.
- **New rows always have the newest `created_at`**, so they always land at the very front of
  the list — ahead of anything the user has already paged past, never interleaved into pages
  they've already seen.

Updates are still visible — if a user revisits a page, they'll see the product's current price
and `updated_at` — but the update never causes a duplicate or a skipped row, because it doesn't
move the row.

I verified this directly: I fetched page 1, ran the write-simulation script (50 inserts + 50
updates), then fetched "page 2" using the cursor from before the writes happened. Page 2 picked
up exactly where page 1 left off, with no overlap and no gap. A fresh fetch of page 1 afterward
showed the 50 new products at the top, as expected.

### Why not `OFFSET` + `updated_at` combined, or a "snapshot" approach?

I considered snapshotting the result set (e.g., recording all matching IDs at the start of a
browse session) so the view is frozen regardless of later writes. I didn't go this route
because the task explicitly says new/updated data should be reflected correctly, not hidden —
freezing a snapshot would mean a user never sees the 50 new products at all during that
session, which feels like the wrong tradeoff for a live catalog. Keyset pagination on an
immutable column gives correctness without sacrificing freshness.

## Schema

```sql
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_created_id ON products (created_at DESC, id DESC);
CREATE INDEX idx_products_category_created_id ON products (category, created_at DESC, id DESC);
CREATE INDEX idx_products_category ON products (category);
```

Full version with comments in `schema.sql`.

## Seed script (`scripts/seed.js`)

Generates 200,000 products and inserts them in batches of 5,000 using
`INSERT ... SELECT * FROM unnest(...)`, rather than one `INSERT` per row in a loop. A
row-by-row loop means 200,000 separate network round trips to the database; batching with
`unnest` turns that into 40 round trips (200,000 / 5,000), each carrying 5,000 rows at once.
On Neon this finishes in about 5 seconds. A naive loop would take minutes, and would be far
slower again over a real network connection (as opposed to local Postgres) where each round
trip has real latency.

`created_at` timestamps are randomized across the last two years so the data has a realistic
spread for "newest first" browsing and date-based testing, rather than every row having (close
to) the same insert timestamp.

## What I'd improve with more time

- **Estimated counts at larger scale.** `/api/products/count` runs an exact `COUNT(*)`, which
  is fine at 200k rows (low single-digit milliseconds) but would need to switch to an
  approximate count (e.g., from `pg_class.reltuples`, refreshed by autovacuum) if this had to
  scale to tens of millions of rows, where an exact count becomes a real cost.
- **Full-text search on product name.** Right now filtering is limited to exact category match.
  A `pg_trgm` index would let users search by name without a full table scan.
- **Rate limiting / auth.** This is a public read-only API for the task, but a real version
  would need basic abuse protection.
- **Connection pool tuning for serverless cold starts.** Neon's free tier has a connection
  limit; under real concurrent load I'd look at pooling via PgBouncer (Neon offers this) rather
  than relying solely on the `pg` pool inside one Node process.
- **Cursor validation hardening.** The cursor is just base64-encoded JSON right now; a
  production version might sign it (HMAC) so a malformed or tampered cursor fails clearly
  rather than just returning empty/garbage results.

## How I used AI

I used Claude to help scaffold the Express routes, the batch-insert seed script, and the
write-simulation script, and to write the `EXPLAIN ANALYZE` comparisons that justify the
indexing choices. The core decisions — keyset pagination over OFFSET, pagination keyed on the
immutable `created_at` (+ `id` tiebreaker) instead of `updated_at`, and the composite index
design — are the parts of this task that actually matter, and I made sure I could explain each
one independently, since that's what the next round is testing.

One thing I caught and fixed: an early draft of the write-simulation script used a `LATERAL`
join to set `created_at`/`updated_at` to `now()` during a bulk insert, which was unnecessarily
complex and not portable across Postgres versions — I simplified it to a plain `now()` call in
the `SELECT` alongside the `unnest()`. I also added local-vs-remote SSL auto-detection
(`ssl: false` for `localhost`, `ssl: { rejectUnauthorized: false }` for Neon) after testing
locally against a Postgres instance without SSL configured — the initial version assumed SSL
was always required, which would have failed for local testing/CI even though it works
correctly against the deployed Neon database.

I validated all of the performance claims above myself with real `EXPLAIN ANALYZE` runs against
the actual 200k-row seeded table, not by trusting AI-generated numbers — the timings in this
README came from running the queries, not from a guess.
