// scripts/simulateWrites.js
//
// Simulates "real world" write traffic: inserts 50 new products and
// updates 50 random existing ones (changing price/updated_at, NOT created_at).
//
// Use this to prove the pagination is consistent: open the browse UI / API,
// start paging through results, then run this script in another terminal
// halfway through. Because pagination is keyed on (created_at, id) and not
// on updated_at, you should see neither duplicates nor gaps - the 50 new
// products appear at the front of the "newest first" list, and the 50
// updated ones stay exactly where they were, just with fresh data.
//
// Run with: npm run simulate-writes

require('dotenv').config();
const { Pool } = require('pg');

const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
});

const CATEGORIES = [
  'Electronics', 'Home & Kitchen', 'Books', 'Clothing', 'Sports & Outdoors',
  'Toys & Games', 'Beauty & Personal Care', 'Automotive', 'Grocery',
  'Office Supplies', 'Pet Supplies', 'Health & Wellness', 'Furniture',
  'Garden & Outdoor', 'Music & Instruments',
];

function randomItem(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

function randomPrice() {
  const value = 99 + Math.random() * 49900;
  return Math.round(value * 100) / 100;
}

async function insertNewProducts(count = 50) {
  const names = [];
  const categories = [];
  const prices = [];
  const now = new Date().toISOString();

  for (let i = 0; i < count; i++) {
    names.push(`New Arrival Product ${Date.now()}-${i}`);
    categories.push(randomItem(CATEGORIES));
    prices.push(randomPrice());
  }

  await pool.query(
    `
    INSERT INTO products (name, category, price, created_at, updated_at)
    SELECT name, category, price, now(), now()
    FROM unnest($1::text[], $2::text[], $3::numeric[]) AS t(name, category, price)
    `,
    [names, categories, prices]
  );

  console.log(`Inserted ${count} new products at ${now}`);
}

async function updateRandomExistingProducts(count = 50) {
  // Pick `count` random existing ids, bump their price and updated_at.
  // created_at is intentionally left untouched.
  const { rows } = await pool.query(
    `SELECT id FROM products ORDER BY random() LIMIT $1`,
    [count]
  );

  for (const row of rows) {
    await pool.query(
      `UPDATE products SET price = $1, updated_at = now() WHERE id = $2`,
      [randomPrice(), row.id]
    );
  }

  console.log(`Updated ${rows.length} existing products (price + updated_at only)`);
}

async function main() {
  console.log('Simulating concurrent write traffic...');
  await insertNewProducts(50);
  await updateRandomExistingProducts(50);
  console.log('Done. created_at ordering for existing rows is unaffected.');
  await pool.end();
}

main().catch((err) => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
