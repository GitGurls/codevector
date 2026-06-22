// src/db.js
// A single shared connection pool for the whole app.
// Neon (and most hosted Postgres) requires SSL.
require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// SSL is required by Neon and most hosted Postgres providers, but local
// Postgres (e.g. for testing) typically doesn't have it configured.
// Auto-detect based on whether we're pointed at localhost.
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10, // Neon free tier has a limited number of connections; keep this modest
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  // Don't crash the whole process on an idle client error
  console.error('Unexpected error on idle pg client', err);
});

module.exports = pool;
