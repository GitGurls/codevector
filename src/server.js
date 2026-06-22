// src/server.js
//
// API for browsing 200k products, newest first, with category filter
// and keyset (cursor) pagination.
//
// WHY KEYSET PAGINATION INSTEAD OF OFFSET/LIMIT:
//
//   OFFSET-based: "SELECT * FROM products ORDER BY created_at DESC
//                  LIMIT 20 OFFSET 50000"
//   Postgres has to walk through and discard 50,000 rows every time you ask
//   for a deep page. That gets linearly slower the further you page in.
//   On 200k rows this is noticeable; it would be much worse at scale.
//
//   Keyset-based: "...WHERE (created_at, id) < ($lastCreatedAt, $lastId)
//                  ORDER BY created_at DESC, id DESC LIMIT 20"
//   This uses the composite index directly: Postgres seeks straight to
//   the right spot in the index and reads forward 20 rows. Cost is
//   independent of how deep you are in the list (O(log n) seek + O(page size)).
//
// WHY (created_at, id) AS A PAIR, NOT created_at ALONE:
//   created_at is not unique (many products can share a timestamp,
//   especially with random seed data). Using created_at alone as a cursor
//   can skip or repeat rows that share the exact same timestamp. Adding
//   id as a tiebreaker makes the sort order (and therefore the cursor)
//   strictly unique, so every row has one unambiguous position.
//
// WHY THIS STAYS CORRECT WHILE DATA IS CHANGING (the "50 products added
// or updated mid-browse" requirement):
//   - created_at is set once at INSERT time and never changes again.
//     Sorting/paginating on an immutable column means a row's position in
//     the "newest first" ordering never shifts after the fact.
//   - New inserts always land at the very front (they have the newest
//     created_at), so they appear ahead of your cursor, not interleaved
//     into pages you've already fetched - you simply see them next time
//     you go back to page 1, never as a duplicate deeper in your scroll.
//   - Updates change updated_at and other columns, but NOT created_at,
//     so an edited product keeps its exact same position in the feed.
//     You'll see its fresh data if you land on that page, but it will
//     not duplicate elsewhere or vanish from where it belongs.
//   - Contrast with OFFSET pagination: if row #5 gets deleted while
//     you're viewing page 1 (offset 0), everything shifts up by one and
//     page 2 (offset 20) now starts one row early - you'd silently skip
//     a row. Keyset pagination has no such shifting because the cursor
//     is a value, not a position/count.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Encode/decode the cursor as a base64 string so it's an opaque token to
// the client (they shouldn't need to know or care it's "created_at + id").
function encodeCursor(createdAt, id) {
  const raw = JSON.stringify({ createdAt, id });
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeCursor(cursorStr) {
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.createdAt || !parsed.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * GET /api/products
 * Query params:
 *   - category (optional): exact category match
 *   - limit (optional): page size, default 20, max 100
 *   - cursor (optional): opaque cursor from the previous page's nextCursor.
 *                         Omit to get the first page (newest products).
 *
 * Response:
 *   {
 *     data: [ { id, name, category, price, created_at, updated_at }, ... ],
 *     nextCursor: string | null   // pass this back to get the next page
 *   }
 */
app.get('/api/products', async (req, res) => {
  try {
    const limit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE)
    );
    const category = req.query.category && req.query.category !== 'all'
      ? req.query.category
      : null;

    let cursor = null;
    if (req.query.cursor) {
      cursor = decodeCursor(req.query.cursor);
      if (!cursor) {
        return res.status(400).json({ error: 'Invalid cursor' });
      }
    }

    const params = [];
    const whereClauses = [];

    if (category) {
      params.push(category);
      whereClauses.push(`category = $${params.length}`);
    }

    if (cursor) {
      // Keyset condition: strictly "older" than the last row we sent.
      // Using a row comparison so it maps to a single index range scan.
      params.push(cursor.createdAt);
      const createdAtParamIdx = params.length;
      params.push(cursor.id);
      const idParamIdx = params.length;
      whereClauses.push(
        `(created_at, id) < ($${createdAtParamIdx}::timestamptz, $${idParamIdx}::uuid)`
      );
    }

    params.push(limit);
    const limitParamIdx = params.length;

    const whereSql = whereClauses.length
      ? `WHERE ${whereClauses.join(' AND ')}`
      : '';

    const sql = `
      SELECT id, name, category, price, created_at, updated_at
      FROM products
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${limitParamIdx}
    `;

    const { rows } = await pool.query(sql, params);

    let nextCursor = null;
    if (rows.length === limit) {
      const last = rows[rows.length - 1];
      nextCursor = encodeCursor(last.created_at, last.id);
    }

    res.json({ data: rows, nextCursor });
  } catch (err) {
    console.error('GET /api/products failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Lets the UI build a category filter dropdown.
app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT category FROM products ORDER BY category ASC`
    );
    res.json({ categories: rows.map((r) => r.category) });
  } catch (err) {
    console.error('GET /api/categories failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Quick count for the UI header ("Showing X of 200,000 products").
// Uses an exact count; fine at 200k rows, would switch to an estimate
// (reltuples from pg_class) if this needed to scale to tens of millions.
app.get('/api/products/count', async (req, res) => {
  try {
    const category = req.query.category && req.query.category !== 'all'
      ? req.query.category
      : null;
    const { rows } = category
      ? await pool.query(`SELECT COUNT(*) FROM products WHERE category = $1`, [category])
      : await pool.query(`SELECT COUNT(*) FROM products`);
    res.json({ count: parseInt(rows[0].count, 10) });
  } catch (err) {
    console.error('GET /api/products/count failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
