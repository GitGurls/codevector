

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
