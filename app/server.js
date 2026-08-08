const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').replace('sslmode=require', 'sslmode=no-verify'),
});

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kontaktanfragen (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT,
        telefon TEXT,
        nachricht TEXT,
        erstellt_am TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    console.log('Datenbank bereit: Tabelle kontaktanfragen existiert.');
  } catch (err) {
    console.error('Fehler beim Anlegen der Tabelle (abgefangen):', err.message);
  }
}
initDb();

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404 - Seite nicht gefunden</h1>');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function parseFormBody(req, cb) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1e6) req.destroy();
  });
  req.on('end', () => {
    const params = new URLSearchParams(body);
    const result = {};
    for (const [key, value] of params) result[key] = value;
    cb(result);
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

process.on('uncaughtException', (err) => {
  console.error('Unerwarteter Fehler (abgefangen):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unerwartete Promise-Ablehnung (abgefangen):', err);
});

const server = http.createServer((req, res) => {
  res.on('error', (err) => {
    console.error('Antwort-Fehler (abgefangen):', err.message);
  });
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(parsedUrl.pathname);
  // Trailing Slash ignorieren (z. B. /kontakt/ soll wie /kontakt behandelt werden)
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  if (pathname === '/kontakt') {
    if (req.method === 'POST') {
      parseFormBody(req, async (data) => {
        const eintrag = {
          name: data.name || '',
          email: data.email || '',
          telefon: data.telefon || '',
          nachricht: data.nachricht || '',
        };
        try {
          await pool.query(
            'INSERT INTO kontaktanfragen (name, email, telefon, nachricht) VALUES ($1, $2, $3, $4)',
            [eintrag.name, eintrag.email, eintrag.telefon, eintrag.nachricht]
          );
          console.log('Neue Kontaktanfrage gespeichert:', eintrag.name, eintrag.email);
        } catch (err) {
          console.error('Fehler beim Speichern der Kontaktanfrage (abgefangen):', err.message);
        }

        const safeName = escapeHtml(eintrag.name || 'Ihnen');
        serveDankePage(res, safeName);
      });
      return;
    }
    // GET/HEAD auf /kontakt (z. B. durch Monitoring-Aufrufe oder direkten Linkklick):
    // freundlich zum Kontaktformular auf der Startseite weiterleiten statt 404.
    res.writeHead(302, { Location: '/#kontakt' });
    res.end();
    return;
  }

  if (pathname === '/') {
    serveFile(res, path.join(ROOT, 'index.html'));
    return;
  }

  // Prevent path traversal
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isFile()) {
      serveFile(res, filePath);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404 - Seite nicht gefunden</h1><a href="/">Zurück zur Startseite</a>');
    }
  });
});

function serveDankePage(res, safeName) {
  const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Danke – Tischlerei Eichblick</title>
<link rel="stylesheet" href="/css/style.css">
</head>
<body>
<div class="danke-page">
  <div class="danke-box">
    <div class="danke-icon">✓</div>
    <h1>Vielen Dank, ${safeName}!</h1>
    <p>Ihre Anfrage ist bei uns eingegangen. Wir melden uns in der Regel innerhalb eines Werktages bei Ihnen.</p>
    <a class="btn btn-primary" href="/">Zurück zur Startseite</a>
  </div>
</div>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

server.on('error', (err) => {
  console.error('Server-Fehler (abgefangen):', err.message);
});

// Höher als der Idle-Timeout des vorgeschalteten Reverse-Proxys/Ingress,
// sonst schließt Node die Verbindung, während der Proxy sie noch nutzt –
// das äußert sich nach außen als sporadischer Timeout/„nicht erreichbar".
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Eichblick Tischlerei läuft auf Port ${PORT}`);
});
