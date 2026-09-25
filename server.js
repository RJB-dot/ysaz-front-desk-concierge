// Front Desk Concierge — standalone server (zero external dependencies; Node 18+ built-ins only)
// Staff chat (gated by a shared passcode) + /admin knowledge base editor (gated by a shared admin password).
// Knowledge base + uploaded flyers are stored as JSON/files on disk (DATA_DIR), so they survive restarts
// as long as DATA_DIR is a persistent volume (see fly.toml).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');

// ---------- tiny .env loader (no dotenv package needed) ----------
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const KB_FILE = path.join(DATA_DIR, 'kb.json');
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');
const SEED_FILE = path.join(__dirname, 'seed', 'kb.seed.json');
const SEED_UPLOADS_DIR = path.join(__dirname, 'seed', 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

const STAFF_PASSCODE = process.env.STAFF_PASSCODE || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const DEMO_MODE = !ANTHROPIC_API_KEY;
// Optional: email staff-submitted questions via Resend (resend.com). Until RESEND_API_KEY is set,
// questions are still saved and listed in /admin — they just aren't emailed.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Front Desk Concierge <onboarding@resend.dev>';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@tucsonymca.org';

if (!SESSION_SECRET) console.warn('WARNING: SESSION_SECRET is not set. Login cookies will use an insecure fallback key. Set SESSION_SECRET before going live.');
if (!STAFF_PASSCODE) console.warn('WARNING: STAFF_PASSCODE is not set — the staff gate will reject everyone until it is.');
if (!ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set — /admin will reject everyone until it is.');
if (!RESEND_API_KEY) console.warn('NOTE: RESEND_API_KEY is not set — staff questions will be saved to /admin but not emailed to ' + SUPPORT_EMAIL + '.');
if (DEMO_MODE) console.warn('DEMO MODE: no ANTHROPIC_API_KEY set — chat answers will be canned placeholders, not real Claude responses.');

// ---------- signed-cookie auth ----------
const secret = SESSION_SECRET || 'insecure-dev-secret-change-me';
function sign(value) {
  const h = crypto.createHmac('sha256', secret).update(value).digest('hex');
  return `${value}.${h}`;
}
function verifyCookie(signed, expected) {
  if (!signed) return false;
  const idx = signed.lastIndexOf('.');
  if (idx === -1) return false;
  const value = signed.slice(0, idx);
  if (value !== expected) return false;
  const expectedSig = sign(value).split('.')[1];
  const actualSig = signed.slice(idx + 1);
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(actualSig));
  } catch {
    return false;
  }
}
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}
function setAuthCookie(res, name, value) {
  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookie = `${name}=${encodeURIComponent(sign(value))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secureFlag}`;
  appendHeader(res, 'Set-Cookie', cookie);
}
function clearAuthCookie(res, name) {
  appendHeader(res, 'Set-Cookie', `${name}=; Path=/; HttpOnly; Max-Age=0`);
}
function appendHeader(res, name, value) {
  const existing = res.getHeader(name);
  if (!existing) res.setHeader(name, value);
  else if (Array.isArray(existing)) res.setHeader(name, existing.concat(value));
  else res.setHeader(name, [existing, value]);
}

// ---------- tiny in-memory rate limiter (login endpoints + question submissions) ----------
const attempts = new Map();
function rateLimited(ip, bucket = 'login', max = 10) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const key = bucket + ':' + ip;
  let rec = attempts.get(key);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + windowMs };
    attempts.set(key, rec);
  }
  rec.count += 1;
  return rec.count > max;
}

// ---------- knowledge base storage ----------
function ensureDataFiles() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(KB_FILE)) {
    const seed = fs.existsSync(SEED_FILE) ? JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) : { entries: [] };
    fs.writeFileSync(KB_FILE, JSON.stringify(seed, null, 2));
    if (fs.existsSync(SEED_UPLOADS_DIR)) {
      for (const f of fs.readdirSync(SEED_UPLOADS_DIR)) {
        fs.copyFileSync(path.join(SEED_UPLOADS_DIR, f), path.join(UPLOADS_DIR, f));
      }
    }
    console.log(`Seeded ${seed.entries.length} knowledge base entries into ${KB_FILE}`);
  }
}
function loadQuestions() {
  if (!fs.existsSync(QUESTIONS_FILE)) return { entries: [] };
  return JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
}
function saveQuestions(q) {
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(q, null, 2));
}
function loadKb() {
  return JSON.parse(fs.readFileSync(KB_FILE, 'utf8'));
}
function saveKb(kb) {
  fs.writeFileSync(KB_FILE, JSON.stringify(kb, null, 2));
}
function newId() {
  return crypto.randomBytes(9).toString('hex');
}
ensureDataFiles();

// ---------- request helpers ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('payload_too_large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('payload_too_large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// Minimal multipart/form-data parser — just enough for a single "file" field plus optional text fields.
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = m ? (m[1] || m[2]) : null;
  if (!boundary) return { fields: {}, files: {} };
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buffer.indexOf(boundaryBuf);
  while (start !== -1) {
    const next = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
    if (next === -1) break;
    let chunk = buffer.slice(start + boundaryBuf.length, next);
    if (chunk.slice(0, 2).toString() === '--') break;
    if (chunk.slice(0, 2).toString('latin1') === '\r\n') chunk = chunk.slice(2);
    if (chunk.slice(-2).toString('latin1') === '\r\n') chunk = chunk.slice(0, -2);
    parts.push(chunk);
    start = next;
  }
  const fields = {}; const files = {};
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const rawHeaders = part.slice(0, headerEnd).toString('utf8');
    const body = part.slice(headerEnd + 4);
    const nameMatch = /name="([^"]+)"/.exec(rawHeaders);
    const filenameMatch = /filename="([^"]*)"/.exec(rawHeaders);
    const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(rawHeaders);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    if (filenameMatch && filenameMatch[1]) {
      files[fieldName] = { filename: filenameMatch[1], contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream', data: body };
    } else {
      fields[fieldName] = body.toString('utf8');
    }
  }
  return { fields, files };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.pdf': 'application/pdf', '.svg': 'image/svg+xml',
};
function sendFile(res, filePath, status) {
  fs.readFile(filePath, (err, data) => {
    if (err) { sendJson(res, 404, { error: 'not_found' }); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(status || 200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  });
}

// ---------- auth ----------
function isStaff(req) { const c = parseCookies(req); return verifyCookie(c.fdc_staff, 'staff'); }
function isAdmin(req) { const c = parseCookies(req); return verifyCookie(c.fdc_admin, 'admin'); }

// ---------- chat helpers ----------
function kbText(kb) {
  if (!kb.entries.length) return '(no entries saved yet)';
  return kb.entries.map((e) => `### ${e.title}${e.attachment ? ' (flyer attached)' : ''}\n${e.content}`).join('\n\n');
}
function findRelatedFlyers(kb, question) {
  const q = question.toLowerCase();
  const words = q.split(/\W+/).filter((w) => w.length > 3);
  return kb.entries.filter((e) => e.attachment && words.some((w) => e.title.toLowerCase().includes(w)));
}
async function callAnthropic(instructions, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1024, system: instructions, messages }),
  });
  if (!r.ok) {
    const errText = await r.text();
    console.error('Anthropic API error', r.status, errText);
    throw new Error('upstream_error');
  }
  const data = await r.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function sendEmailViaResend(to, subject, html, replyTo) {
  const payload = { from: EMAIL_FROM, to: [to], subject, html };
  if (replyTo) payload.reply_to = replyTo;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + RESEND_API_KEY },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    console.error('Resend error', r.status, await r.text());
    throw new Error('email_failed');
  }
}

// ---------- route table ----------
const routes = [];
function route(method, pattern, handler) {
  const paramNames = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { paramNames.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, paramNames, handler });
}

route('GET', '/', async (req, res) => {
  sendFile(res, path.join(PUBLIC_DIR, (isStaff(req) || isAdmin(req)) ? 'chat.html' : 'gate.html'));
});
route('GET', '/admin', async (req, res) => {
  sendFile(res, path.join(PUBLIC_DIR, isAdmin(req) ? 'admin.html' : 'admin-login.html'));
});

route('POST', '/api/staff-login', async (req, res, params, ip) => {
  if (rateLimited(ip)) return sendJson(res, 429, { error: 'rate_limited' });
  const body = await readJsonBody(req, 4096).catch(() => ({}));
  if (STAFF_PASSCODE && body.passcode === STAFF_PASSCODE) {
    setAuthCookie(res, 'fdc_staff', 'staff');
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 401, { error: 'wrong_passcode' });
});
route('POST', '/api/admin-login', async (req, res, params, ip) => {
  if (rateLimited(ip)) return sendJson(res, 429, { error: 'rate_limited' });
  const body = await readJsonBody(req, 4096).catch(() => ({}));
  if (ADMIN_PASSWORD && body.password === ADMIN_PASSWORD) {
    setAuthCookie(res, 'fdc_admin', 'admin');
    setAuthCookie(res, 'fdc_staff', 'staff');
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 401, { error: 'wrong_password' });
});
route('POST', '/api/logout', async (req, res) => {
  clearAuthCookie(res, 'fdc_staff');
  clearAuthCookie(res, 'fdc_admin');
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/health', async (req, res) => sendJson(res, 200, { ok: true, demoMode: DEMO_MODE }));

route('POST', '/api/chat', async (req, res) => {
  if (!isStaff(req) && !isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  const body = await readJsonBody(req, 20000).catch(() => null);
  if (!body || !body.question || typeof body.question !== 'string' || !body.question.trim()) {
    return sendJson(res, 400, { error: 'missing_question' });
  }
  const kb = loadKb();
  const flyers = findRelatedFlyers(kb, body.question).map((e) => ({ id: e.id, title: e.title, filename: e.attachment.filename, url: `/uploads/${e.attachment.path}` }));

  if (DEMO_MODE) {
    return sendJson(res, 200, {
      answer: "This is a demo answer — no Anthropic API key is configured yet, so I can't ask Claude anything real. Once ANTHROPIC_API_KEY is set, this will answer only from the saved knowledge base, the same way it did as a Claude artifact.",
      flyers, demo: true,
    });
  }

  const instructions =
    'You are the Front Desk Concierge assistant for YMCA of Southern Arizona. ' +
    'Front-line staff are asking you questions while a member is at the counter, so answer briefly and plainly, leading with the direct answer. ' +
    "Only use the knowledge base below. If the answer isn't in it, say clearly that it isn't in the saved knowledge base yet and suggest checking with a supervisor — never guess at hours, prices, or policy. " +
    "Some entries are marked '(flyer attached)' — if one of those is relevant, mention that a flyer is available so staff know to show or print it.\n\n" +
    `=== KNOWLEDGE BASE ===\n${kbText(kb)}\n=== END KNOWLEDGE BASE ===`;
  const messages = [];
  if (Array.isArray(body.history)) {
    for (const h of body.history.slice(-12)) {
      if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') messages.push({ role: h.role, content: h.content });
    }
  }
  messages.push({ role: 'user', content: body.question });

  try {
    const answer = await callAnthropic(instructions, messages);
    sendJson(res, 200, { answer, flyers });
  } catch {
    sendJson(res, 502, { error: 'upstream_error' });
  }
});

// Front desk staff send a question the concierge couldn't answer. Always saved (listed in /admin);
// also emailed to SUPPORT_EMAIL when Resend is configured.
route('POST', '/api/questions', async (req, res, params, ip) => {
  if (!isStaff(req) && !isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  if (rateLimited(ip, 'questions', 20)) return sendJson(res, 429, { error: 'rate_limited' });
  const body = await readJsonBody(req, 20000).catch(() => null);
  const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const question = clip(body && body.question, 2000);
  const name = clip(body && body.name, 100);
  if (!question || !name) return sendJson(res, 400, { error: 'missing_fields' });
  const entry = {
    id: newId(), question, name,
    branch: clip(body.branch, 100), details: clip(body.details, 4000),
    createdAt: Date.now(), handled: false, emailed: false,
  };

  if (RESEND_API_KEY) {
    const row = (label, val) => val ? `<p><strong>${label}:</strong><br>${escapeHtml(val).replace(/\n/g, '<br>')}</p>` : '';
    const html =
      "<p>A front desk staff member asked a question the Front Desk Concierge couldn't answer.</p>" +
      row('Question', entry.question) + row('From', entry.name) + row('Branch', entry.branch) + row('Details', entry.details) +
      '<p style="color:#666;font-size:12px">Once it&#39;s answered, add it to the knowledge base at /admin so the concierge can answer it next time.</p>';
    try {
      await sendEmailViaResend(SUPPORT_EMAIL, 'Front desk question: ' + entry.question.slice(0, 80), html);
      entry.emailed = true;
    } catch { /* still saved below — shows as "not emailed" in /admin */ }
  }

  const q = loadQuestions();
  q.entries.push(entry);
  saveQuestions(q);
  sendJson(res, 200, { ok: true, emailed: entry.emailed });
});
route('GET', '/api/admin/questions', async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  const entries = loadQuestions().entries.slice().sort((a, b) => (a.handled - b.handled) || (b.createdAt - a.createdAt));
  sendJson(res, 200, entries);
});
route('PUT', '/api/admin/questions/:id', async (req, res, params) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  const body = await readJsonBody(req, 4096).catch(() => null);
  const q = loadQuestions();
  const entry = q.entries.find((e) => e.id === params.id);
  if (!entry) return sendJson(res, 404, { error: 'not_found' });
  entry.handled = !!(body && body.handled);
  saveQuestions(q);
  sendJson(res, 200, entry);
});

route('GET', '/api/admin/kb', async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  const kb = loadKb();
  sendJson(res, 200, kb.entries.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
});
route('POST', '/api/admin/kb', async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  const body = await readJsonBody(req, 200000).catch(() => null);
  if (!body || !body.title || !body.content) return sendJson(res, 400, { error: 'missing_fields' });
  const kb = loadKb();
  const entry = { id: newId(), title: String(body.title).trim(), content: String(body.content).trim(), attachment: null, updatedAt: Date.now() };
  kb.entries.push(entry);
  saveKb(kb);
  sendJson(res, 200, entry);
});
route('PUT', '/api/admin/kb/:id', async (req, res, params) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  const body = await readJsonBody(req, 200000).catch(() => null);
  if (!body || !body.title || !body.content) return sendJson(res, 400, { error: 'missing_fields' });
  const kb = loadKb();
  const entry = kb.entries.find((e) => e.id === params.id);
  if (!entry) return sendJson(res, 404, { error: 'not_found' });
  entry.title = String(body.title).trim();
  entry.content = String(body.content).trim();
  entry.updatedAt = Date.now();
  saveKb(kb);
  sendJson(res, 200, entry);
});
route('DELETE', '/api/admin/kb/:id', async (req, res, params) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  const kb = loadKb();
  const idx = kb.entries.findIndex((e) => e.id === params.id);
  if (idx === -1) return sendJson(res, 404, { error: 'not_found' });
  const [removed] = kb.entries.splice(idx, 1);
  saveKb(kb);
  if (removed.attachment) { const p = path.join(UPLOADS_DIR, removed.attachment.path); fs.existsSync(p) && fs.unlinkSync(p); }
  sendJson(res, 200, { ok: true });
});

const ALLOWED_UPLOAD_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'];
route('POST', '/api/admin/kb/:id/attachment', async (req, res, params) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  const kb = loadKb();
  const entry = kb.entries.find((e) => e.id === params.id);
  if (!entry) return sendJson(res, 404, { error: 'not_found' });
  let raw;
  try { raw = await readRawBody(req, 20 * 1024 * 1024); } catch { return sendJson(res, 413, { error: 'too_large' }); }
  const { files } = parseMultipart(raw, req.headers['content-type']);
  const file = files.file;
  if (!file) return sendJson(res, 400, { error: 'missing_file' });
  if (!ALLOWED_UPLOAD_TYPES.includes(file.contentType)) return sendJson(res, 400, { error: 'unsupported_type' });
  if (entry.attachment) { const p = path.join(UPLOADS_DIR, entry.attachment.path); fs.existsSync(p) && fs.unlinkSync(p); }
  const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storedName = `${newId()}-${safeName}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, storedName), file.data);
  entry.attachment = { filename: file.filename, path: storedName, contentType: file.contentType };
  entry.updatedAt = Date.now();
  saveKb(kb);
  sendJson(res, 200, entry);
});
route('DELETE', '/api/admin/kb/:id/attachment', async (req, res, params) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  const kb = loadKb();
  const entry = kb.entries.find((e) => e.id === params.id);
  if (!entry) return sendJson(res, 404, { error: 'not_found' });
  if (entry.attachment) {
    const p = path.join(UPLOADS_DIR, entry.attachment.path);
    fs.existsSync(p) && fs.unlinkSync(p);
    entry.attachment = null;
    entry.updatedAt = Date.now();
    saveKb(kb);
  }
  sendJson(res, 200, entry);
});

route('GET', '/uploads/:filename', async (req, res, params) => {
  if (!isStaff(req) && !isAdmin(req)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('Please log in first.'); }
  const filePath = path.join(UPLOADS_DIR, path.basename(params.filename));
  sendFile(res, filePath);
});

// Static files under /public (style.css, app.js, admin.js) — no auth needed, they're inert without the API.
route('GET', '/style.css', async (req, res) => sendFile(res, path.join(PUBLIC_DIR, 'style.css')));
route('GET', '/app.js', async (req, res) => sendFile(res, path.join(PUBLIC_DIR, 'app.js')));
route('GET', '/admin.js', async (req, res) => sendFile(res, path.join(PUBLIC_DIR, 'admin.js')));

const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.paramNames.forEach((name, i) => { params[name] = m[i + 1]; });
    try {
      await r.handler(req, res, params, ip);
    } catch (err) {
      console.error('Handler error', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    }
    return;
  }
  sendJson(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`Front Desk Concierge listening on :${PORT}${DEMO_MODE ? ' (DEMO MODE)' : ''}`);
});
