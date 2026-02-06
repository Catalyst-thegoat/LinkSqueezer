const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'linksqueezer-secret-change-in-prod';
const PORT = process.env.PORT || 3000;

const app = express();

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

// Auth Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth: Register
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const id = nanoid(10);
    const passwordHash = await bcrypt.hash(password, 10);

    const stmt = db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)');
    stmt.run(id, email, passwordHash);

    const token = jwt.sign({ id, email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      data: { user: { id, email }, token }
    });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Auth: Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
  const user = stmt.get(email);

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const validPassword = await bcrypt.compare(password, user.password_hash);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

  res.json({
    success: true,
    data: { user: { id: user.id, email: user.email }, token }
  });
});

// Create a new link
app.post('/api/links', authenticateToken, (req, res) => {
  const { originalUrl, title, customCode } = req.body;
  
  if (!originalUrl) {
    return res.status(400).json({ error: 'originalUrl is required' });
  }

  const shortCode = customCode || nanoid(6);
  const id = nanoid(10);

  try {
    const stmt = db.prepare('INSERT INTO links (id, user_id, original_url, short_code, title) VALUES (?, ?, ?, ?, ?)');
    stmt.run(id, req.user.id, originalUrl, shortCode, title || null);
    
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

// Get all links for authenticated user
app.get('/api/links', authenticateToken, (req, res) => {
  const stmt = db.prepare('SELECT * FROM links WHERE user_id = ? ORDER BY created_at DESC');
  const links = stmt.all(req.user.id);
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

app.listen(PORT, () => {
  console.log(`🚀 LinkSqueezer running on http://localhost:${PORT}`);
});
