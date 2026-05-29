/**
 * server.js — entry point
 *
 * Creates the MySQL pool, validates DB connectivity with retries,
 * then starts the HTTP listener. The Express app logic lives in app.js
 * so tests can import it without binding a port.
 */

'use strict';

const mysql  = require('mysql2/promise');
const { createApp } = require('./app');

const PORT = process.env.PORT || 3000;

const pool = mysql.createPool({
  host:               process.env.DB_HOST || '127.0.0.1',
  port:     parseInt(process.env.DB_PORT  || '3306'),
  database:           process.env.DB_NAME || 'insurance_db',
  user:               process.env.DB_USER || 'root',
  password:           process.env.DB_PASS || 'rootpassword',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
});

async function startServer() {
  let retries = 5;
  while (retries > 0) {
    try {
      console.log(`[startup] Attempting DB connection (${6 - retries}/5)...`);
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
      console.log('[startup] Database connection successful ✓');
      break;
    } catch (err) {
      retries--;
      if (retries === 0) {
        console.error('[startup] Could not connect to database after 5 attempts:', err.message);
        process.exit(1);
      }
      console.log(`[startup] Retrying in 3s... (${retries} attempts left)`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  const app = createApp(pool);
  app.listen(PORT, () => {
    console.log(`[server] insurance-api listening on port ${PORT}`);
    console.log(`[server] Endpoints: GET /health  |  GET /api/policies`);
  });
}

startServer();
