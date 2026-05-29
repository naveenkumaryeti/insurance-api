/**
 * api.test.js
 *
 * Integration-style tests for insurance-api.
 * Uses supertest to fire real HTTP requests against the Express app
 * with a REAL MySQL connection (GitHub Actions spins up mysql:8.0 as a service).
 *
 * Test suites:
 *   1. GET /health           — connectivity + response shape
 *   2. GET /api/policies     — data retrieval + response shape
 *   3. GET /api/policies     — field validation on every returned row
 *   4. 404 handler           — unknown routes
 *   5. DB failure simulation — mock pool returning an error
 */

'use strict';

const request = require('supertest');
const mysql   = require('mysql2/promise');
const { createApp } = require('../app');

// ── Shared pool (one connection across all tests in this file) ──
let pool;
let app;

beforeAll(async () => {
  // Connect to the real MySQL service spun up by GitHub Actions
  pool = mysql.createPool({
    host:               process.env.DB_HOST || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT  || '3306'),
    database:           process.env.DB_NAME || 'insurance_db',
    user:               process.env.DB_USER || 'root',
    password:           process.env.DB_PASS || 'rootpassword',
    waitForConnections: true,
    connectionLimit:    5,
    queueLimit:         0,
  });

  // Wait for MySQL to be ready (CI services can take a moment)
  let retries = 10;
  while (retries > 0) {
    try {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
      break;
    } catch {
      retries--;
      if (retries === 0) throw new Error('MySQL not reachable after 10 retries');
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  app = createApp(pool);
}, 30_000); // 30s timeout — CI MySQL can be slow to start

afterAll(async () => {
  await pool.end();
});

// ── Suite 1: Health endpoint ─────────────────────────────────────
describe('GET /health', () => {
  it('returns 200 with status=healthy when DB is reachable', async () => {
    const res = await request(app).get('/health');

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.service).toBe('insurance-api');
    expect(res.body.db).toBe('connected');
  });

  it('response includes a valid ISO timestamp', async () => {
    const res = await request(app).get('/health');

    expect(res.body.timestamp).toBeDefined();
    const parsed = new Date(res.body.timestamp);
    expect(parsed.toString()).not.toBe('Invalid Date');
  });

  it('response includes hostname field', async () => {
    const res = await request(app).get('/health');

    expect(typeof res.body.hostname).toBe('string');
    expect(res.body.hostname.length).toBeGreaterThan(0);
  });
});

// ── Suite 2: Policies endpoint — response shape ──────────────────
describe('GET /api/policies', () => {
  it('returns 200 with success=true', async () => {
    const res = await request(app).get('/api/policies');

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('response contains a data array', async () => {
    const res = await request(app).get('/api/policies');

    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('count field matches actual data array length', async () => {
    const res = await request(app).get('/api/policies');

    expect(res.body.count).toBe(res.body.data.length);
  });

  it('returns at least the 4 seeded policies', async () => {
    const res = await request(app).get('/api/policies');

    // The V1 migration seeds exactly 4 rows; count >= 4 in case more were added
    expect(res.body.data.length).toBeGreaterThanOrEqual(4);
  });

  it('returns JSON content-type', async () => {
    const res = await request(app).get('/api/policies');

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

// ── Suite 3: Policies endpoint — field validation ────────────────
describe('GET /api/policies — row field validation', () => {
  let policies;

  beforeAll(async () => {
    const res = await request(app).get('/api/policies');
    policies = res.body.data;
  });

  it('every row has an id field', () => {
    policies.forEach(p => expect(p.id).toBeDefined());
  });

  it('every row has a policy_no matching POL-YYYY-NNNN format', () => {
    policies.forEach(p => {
      expect(p.policy_no).toMatch(/^POL-\d{4}-\d{4}$/);
    });
  });

  it('every row has a non-empty holder_name', () => {
    policies.forEach(p => {
      expect(typeof p.holder_name).toBe('string');
      expect(p.holder_name.trim().length).toBeGreaterThan(0);
    });
  });

  it('every row has a valid type (health | vehicle | life)', () => {
    const validTypes = ['health', 'vehicle', 'life'];
    policies.forEach(p => {
      expect(validTypes).toContain(p.type);
    });
  });

  it('every row has a valid status (active | expired | pending)', () => {
    const validStatuses = ['active', 'expired', 'pending'];
    policies.forEach(p => {
      expect(validStatuses).toContain(p.status);
    });
  });

  it('every row has a premium that is a positive number', () => {
    policies.forEach(p => {
      const premium = parseFloat(p.premium);
      expect(isNaN(premium)).toBe(false);
      expect(premium).toBeGreaterThan(0);
    });
  });

  it('every row has a created_at parseable as a date', () => {
    policies.forEach(p => {
      const d = new Date(p.created_at);
      expect(d.toString()).not.toBe('Invalid Date');
    });
  });

  it('seed data contains Naveen Reddy with health policy', () => {
    const naveen = policies.find(p => p.holder_name === 'Naveen Reddy');
    expect(naveen).toBeDefined();
    expect(naveen.type).toBe('health');
    expect(naveen.policy_no).toBe('POL-2024-0001');
  });

  it('seed data contains an active policy', () => {
    const active = policies.filter(p => p.status === 'active');
    expect(active.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Suite 4: 404 handler ─────────────────────────────────────────
describe('404 handler', () => {
  it('returns 404 for unknown GET route', async () => {
    const res = await request(app).get('/api/nonexistent');

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 404 for unknown POST route', async () => {
    const res = await request(app).post('/api/policies');

    expect(res.statusCode).toBe(404);
  });

  it('error message includes the method and path', async () => {
    const res = await request(app).get('/api/unknown-route');

    expect(res.body.error).toContain('GET');
    expect(res.body.error).toContain('/api/unknown-route');
  });
});

// ── Suite 5: DB failure simulation ──────────────────────────────
// Creates a separate app instance with a broken pool to test error paths
// without affecting the real DB connection used by other suites.
describe('DB failure handling', () => {
  let brokenApp;

  beforeAll(() => {
    // Mock pool that always rejects — simulates DB going offline mid-request
    const brokenPool = {
      getConnection: () => Promise.reject(new Error('Connection refused')),
      execute:       () => Promise.reject(new Error('Connection refused')),
    };
    brokenApp = createApp(brokenPool);
  });

  it('GET /health returns 503 when DB is unreachable', async () => {
    const res = await request(brokenApp).get('/health');

    expect(res.statusCode).toBe(503);
    expect(res.body.status).toBe('unhealthy');
    expect(res.body.db).toBe('disconnected');
  });

  it('GET /health error body includes error message', async () => {
    const res = await request(brokenApp).get('/health');

    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it('GET /api/policies returns 500 when DB query fails', async () => {
    const res = await request(brokenApp).get('/api/policies');

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
  });
});
