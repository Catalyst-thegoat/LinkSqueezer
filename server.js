const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database Setup
const db = new Database('linksqueezer.db');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    original_url TEXT NOT NULL,
    short_code TEXT UNIQUE NOT NULL,
    title TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS clicks (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL,
    user_agent TEXT,
    referer TEXT,
    country TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (link_id) REFERENCES links(id)
  );

  CREATE INDEX IF NOT EXISTS idx_links_short_code ON links(short_code);
  CREATE INDEX IF NOT EXISTS idx_clicks_link_id ON clicks(link_id);
`);

// API Routes

// Create a new link
app.post('/api/links', (req, res) => {
  const { originalUrl, title, customCode } = req.body;
  
  if (!originalUrl) {
    return res.status(400).json({ error: 'originalUrl is required' });
  }

  const shortCode = customCode || nanoid(6);
  const id = nanoid(10);

  try {
    const stmt = db.prepare('INSERT INTO links (id, user_id, original_url, short_code, title) VALUES (?, ?, ?, ?, ?)');
    stmt.run(id, 'demo-user', originalUrl, shortCode, title || null);
    
    res.json({
      success: true,
      data: {
        id,
        originalUrl,
        shortCode,
        shortUrl: `http://localhost:${PORT}/${shortCode}`,
        title
      }
    });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Short code already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Get all links
app.get('/api/links', (req, res) => {
  const stmt = db.prepare('SELECT * FROM links WHERE user_id = ? ORDER BY created_at DESC');
  const links = stmt.all('demo-user');
  res.json({ success: true, data: links });
});

// Redirect short link and track click
app.get('/:shortCode', (req, res) => {
  const { shortCode } = req.params;

  const stmt = db.prepare('SELECT * FROM links WHERE short_code = ? AND is_active = 1');
  const link = stmt.get(shortCode);

  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }

  // Track click (async, don't wait)
  const clickId = nanoid(10);
  db.prepare('INSERT INTO clicks (id, link_id, user_agent, referer) VALUES (?, ?, ?, ?)').run(
    clickId, link.id, req.headers['user-agent'] || null, req.headers['referer'] || null
  );

  res.redirect(link.original_url);
});

// Get analytics for a link
app.get('/api/links/:id/analytics', (req, res) => {
  const { id } = req.params;

  const linkStmt = db.prepare('SELECT * FROM links WHERE id = ?');
  const link = linkStmt.get(id);

  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }

  const clicksStmt = db.prepare(`
    SELECT 
      COUNT(*) as total_clicks,
      COUNT(DISTINCT DATE(created_at)) as active_days
    FROM clicks 
    WHERE link_id = ?
  `);
  const stats = clicksStmt.get(id);

  const dailyStmt = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as clicks
    FROM clicks
    WHERE link_id = ?
    GROUP BY DATE(created_at)
    ORDER BY date DESC
    LIMIT 7
  `);
  const daily = dailyStmt.all(id);

  res.json({
    success: true,
    data: {
      ...link,
      stats,
      daily
    }
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 LinkSqueezer running on http://localhost:${PORT}`);
});
