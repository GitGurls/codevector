// scripts/seed.js
//
// Generates 200,000 products and inserts them FAST.
//
// Why not a loop with 200,000 individual INSERT statements?
// Each INSERT is a network round trip to Neon. At even 5ms per round trip,
// 200,000 of them is 1000+ seconds (~17 minutes), and in practice it's much
// worse because of connection/transaction overhead per statement.
//
// Instead we build big arrays in memory and send them in batches of 5,000
// using `unnest($1::text[], $2::text[], ...)`, which lets Postgres insert
// many rows from a single INSERT statement, with one round trip per batch.
// 200,000 rows / 5,000 per batch = 40 round trips total instead of 200,000.
//
// Run with: npm run seed

require('dotenv').config();
const { Pool } = require('pg');

const TOTAL_PRODUCTS = 200_000;
const BATCH_SIZE = 5_000;

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

const ADJECTIVES = [
  'Premium', 'Compact', 'Wireless', 'Portable', 'Eco-Friendly', 'Heavy-Duty',
  'Lightweight', 'Smart', 'Classic', 'Deluxe', 'Professional', 'Ultra',
  'Rechargeable', 'Adjustable', 'All-in-One',
];

const NOUNS = [
  'Backpack', 'Blender', 'Headphones', 'Desk Lamp', 'Water Bottle', 'Keyboard',
  'Notebook', 'Chair', 'Speaker', 'Charger', 'Sneakers', 'Watch', 'Mug',
  'Jacket', 'Tent', 'Yoga Mat', 'Camera', 'Monitor', 'Toolkit', 'Pillow',
];

function randomItem(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

function randomPrice() {
  // Between 99 and 49999, two decimal places - feels like real e-commerce data.
  const value = 99 + Math.random() * 49900;
  return Math.round(value * 100) / 100;
}

// Spread created_at over the last ~2 years so "newest first" pagination
// and date-based filtering both have realistic data to work with.
function randomCreatedAt() {
  const now = Date.now();
  const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;
  const past = now - Math.random() * twoYearsMs;
  return new Date(past);
}

async function seed() {
  console.log(`Seeding ${TOTAL_PRODUCTS} products in batches of ${BATCH_SIZE}...`);
  const start = Date.now();

  // Make sure schema exists (safe to run repeatedly).
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price NUMERIC(10, 2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_created_id ON products (created_at DESC, id DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_category_created_id ON products (category, created_at DESC, id DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);`);

  let inserted = 0;

  for (let batchStart = 0; batchStart < TOTAL_PRODUCTS; batchStart += BATCH_SIZE) {
    const batchCount = Math.min(BATCH_SIZE, TOTAL_PRODUCTS - batchStart);

    const names = new Array(batchCount);
    const categories = new Array(batchCount);
    const prices = new Array(batchCount);
    const createdAts = new Array(batchCount);
    const updatedAts = new Array(batchCount);

    for (let i = 0; i < batchCount; i++) {
      const name = `${randomItem(ADJECTIVES)} ${randomItem(NOUNS)}`;
      const createdAt = randomCreatedAt();
      names[i] = name;
      categories[i] = randomItem(CATEGORIES);
      prices[i] = randomPrice();
      createdAts[i] = createdAt.toISOString();
      updatedAts[i] = createdAt.toISOString(); // same as created_at initially
    }

    // unnest() turns parallel arrays into rows - one INSERT, batchCount rows.
    await pool.query(
      `
      INSERT INTO products (name, category, price, created_at, updated_at)
      SELECT * FROM unnest(
        $1::text[], $2::text[], $3::numeric[], $4::timestamptz[], $5::timestamptz[]
      )
      `,
      [names, categories, prices, createdAts, updatedAts]
    );

    inserted += batchCount;
    process.stdout.write(`\rInserted ${inserted}/${TOTAL_PRODUCTS}`);
  }

  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone. Inserted ${inserted} products in ${seconds}s.`);
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
