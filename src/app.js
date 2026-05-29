/**
 * app.js — Express app factory
 *
 * Exports a function that receives an already-connected MySQL pool
 * and returns a fully configured Express app WITH NO open listener.
 *
 * Why separate app from server?
 *   - Tests import createApp(pool) with a mock/real pool → no port conflicts
 *   - server.js calls createApp(pool) then app.listen() → production unchanged
 *   - Each test file gets a fresh app instance with isolated state
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const os      = require('os');

function createApp(pool) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  /**
   * DB ping helper — tests connectivity.
   * Used by /health endpoint and startup validation.
   */
  async function dbPing() {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
  }

  /**
   * GET /health
   * Liveness + DB connectivity check.
   * Kubernetes readiness probe hits this; 200 = ready, 503 = not ready.
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
   * Returns all insurance policies ordered newest-first.
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

  app.use((req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
  });

  return app;
}

module.exports = { createApp };
