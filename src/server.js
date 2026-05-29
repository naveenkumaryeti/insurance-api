/**
 * insurance-api/src/server.js
 *
 * Simple Express REST API for the Insurance application.
 * Connects to MySQL and exposes two endpoints:
 *
 *   GET /health        — liveness + DB connectivity check
 *   GET /api/policies  — list all policies from the DB
 *
 * Environment variables (set via K8s ConfigMap or .env):
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, PORT
 */

'use strict';

const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const os      = require('os');                 // used for hostname in health response

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());                               // allow insurance-web to call us
app.use(express.json());

// ── MySQL connection pool ─────────────────────────────────────
// Pool (not single connection) handles reconnects and concurrent requests
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

/**
 * DB ping helper — tests connectivity without exposing the pool directly.
 * Used by the health endpoint (readiness probe) and startup validation.
 */
async function dbPing() {
  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();
}

// ── Startup DB validation ─────────────────────────────────────
// The server refuses to start if the database isn't reachable.
// This surfaces mis-configuration immediately rather than at request time.
async function startServer() {
  let retries = 5;
  while (retries > 0) {
    try {
      console.log(`[startup] Attempting DB connection (${6 - retries}/5)...`);
      await dbPing();
      console.log('[startup] Database connection successful ✓');
      break;
    } catch (err) {
      retries--;
      if (retries === 0) {
        console.error('[startup] Could not connect to database after 5 attempts:', err.message);
        process.exit(1);                       // fail fast — let K8s restart the pod
      }
      console.log(`[startup] Retrying in 3s... (${retries} attempts left)`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // ── Routes ────────────────────────────────────────────────────

  /**
   * GET /health
   * Returns service metadata + live DB ping result.
   * Kubernetes readiness probe hits this endpoint; 200 = ready, 5xx = not ready.
   */
  app.get('/health', async (req, res) => {
    try {
      await dbPing();
      res.json({
        status:    'healthy',
        service:   'insurance-api',
        hostname:  os.hostname(),
        db:        'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      // DB unreachable — return 503 so K8s marks the pod as not-ready
      res.status(503).json({
        status:    'unhealthy',
        service:   'insurance-api',
        db:        'disconnected',
        error:     err.message,
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * GET /api/policies
   * Returns all insurance policies from the database.
   * In a real app you'd add pagination, filters, and auth middleware here.
   */
  app.get('/api/policies', async (req, res) => {
    try {
      const [rows] = await pool.execute(
        'SELECT id, policy_no, holder_name, type, premium, status, created_at FROM policies ORDER BY created_at DESC'
      );
      res.json({
        success: true,
        count:   rows.length,
        data:    rows,
      });
    } catch (err) {
      console.error('[/api/policies] DB error:', err.message);
      res.status(500).json({ success: false, error: 'Database query failed' });
    }
  });

  // ── 404 handler ───────────────────────────────────────────────
  app.use((req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
  });

  // ── Start listening ───────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[server] insurance-api listening on port ${PORT}`);
    console.log(`[server] Endpoints: GET /health  |  GET /api/policies`);
  });
}

startServer();
