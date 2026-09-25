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
const WEB_PAGES_FILE = path.join(DATA_DIR, 'web-pages.json');
const WEB_REVIEW_FILE = path.join(DATA_DIR, 'web-review.json');
const ANNOUNCEMENTS_FILE = path.join(DATA_DIR, 'announcements.json');
const INBOUND_SECRET_FILE = path.join(DATA_DIR, 'inbound-secret.txt');
// Public URL of this app, used in the Gmail setup script shown in /admin.
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://ysaz-front-desk-concierge.fly.dev';
// Emails from these domains become live announcements right away; anything else waits for approval in /admin.
const TRUSTED_EMAIL_DOMAINS = ['tucsonymca.org'];

// Every page in the tucsonymca.org page sitemap is downloaded every Monday morning (Arizona time) and
// searchable by the concierge; Claude then reviews each page for out-of-date content and emails
// SUPPORT_EMAIL a list. The pages below are "pinned": always included with every question, not just
// when a search finds them.
const SITEMAP_URL = 'https://tucsonymca.org/page-sitemap.xml';
const WEB_SOURCES = [
  { url: 'https://tucsonymca.org/tax-credit/', title: 'YMCA Tax Credit Fund' },
  { url: 'https://tucsonymca.org/sports/', title: 'Sports Programs (overview)', sports: true },
  { url: 'https://tucsonymca.org/youth-leagues/', title: 'Youth Sports Leagues (see "Upcoming Season Information" for the next seasons)', sports: true },
  { url: 'https://tucsonymca.org/youth-clinics/', title: 'Youth Sports Clinics', sports: true },
  { url: 'https://tucsonymca.org/active-youth-programs/', title: 'Active Youth Programs', sports: true },
  { url: 'https://tucsonymca.org/adult-sports-and-programs/', title: 'Adult Sports & Programs', sports: true },
];
const SEED_FILE = path.join(__dirname, 'seed', 'kb.seed.json');
const SEED_UPLOADS_DIR = path.join(__dirname, 'seed', 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

const STAFF_PASSCODE = process.env.STAFF_PASSCODE || '';
// The staff chat is open to anyone with the link (no passcode). Set REQUIRE_STAFF_PASSCODE=true to bring
// the passcode page back. /admin always needs ADMIN_PASSWORD.
const REQUIRE_STAFF_PASSCODE = process.env.REQUIRE_STAFF_PASSCODE === 'true';
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
if (REQUIRE_STAFF_PASSCODE && !STAFF_PASSCODE) console.warn('WARNING: STAFF_PASSCODE is not set — the staff gate will reject everyone until it is.');
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
function loadWebPages() {
  if (!fs.existsSync(WEB_PAGES_FILE)) return {};
  return JSON.parse(fs.readFileSync(WEB_PAGES_FILE, 'utf8'));
}
function saveWebPages(p) {
  fs.writeFileSync(WEB_PAGES_FILE, JSON.stringify(p, null, 2));
}
function loadAnnouncements() {
  if (!fs.existsSync(ANNOUNCEMENTS_FILE)) return { entries: [], emailIds: [] };
  return JSON.parse(fs.readFileSync(ANNOUNCEMENTS_FILE, 'utf8'));
}
function saveAnnouncements(a) {
  fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(a, null, 2));
}
// The same email often arrives more than once (several staff forward it); same title + start date = same announcement.
function announcementKey(a) {
  return String(a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '|' + (a.starts || '');
}
function dedupeAnnouncements() {
  const store = loadAnnouncements();
  const seen = new Set();
  const before = store.entries.length;
  store.entries = store.entries.filter((a) => { const k = announcementKey(a); if (seen.has(k)) return false; seen.add(k); return true; });
  if (store.entries.length !== before) { saveAnnouncements(store); console.log(`Removed ${before - store.entries.length} duplicate announcement(s)`); }
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
if (fs.existsSync(ANNOUNCEMENTS_FILE)) dedupeAnnouncements();

// New answers (e.g. SOPs) can ship as files: seed/imports/*.json = { entries: [{ id, title, content }] }.
// Each entry is added to the knowledge base once (remembered in imports-applied.json); after that it's
// edited or deleted in /admin like any other answer and never re-added.
const IMPORTS_DIR = path.join(__dirname, 'seed', 'imports');
const IMPORTS_APPLIED_FILE = path.join(DATA_DIR, 'imports-applied.json');
(function applyKbImports() {
  if (!fs.existsSync(IMPORTS_DIR)) return;
  const applied = new Set(fs.existsSync(IMPORTS_APPLIED_FILE) ? JSON.parse(fs.readFileSync(IMPORTS_APPLIED_FILE, 'utf8')) : []);
  const kb = loadKb();
  let added = 0;
  for (const file of fs.readdirSync(IMPORTS_DIR).filter((f) => f.endsWith('.json')).sort()) {
    for (const e of JSON.parse(fs.readFileSync(path.join(IMPORTS_DIR, file), 'utf8')).entries || []) {
      if (!e.id || applied.has(e.id)) continue;
      kb.entries.push({ id: newId(), title: String(e.title).trim(), content: String(e.content).trim(), attachment: null, updatedAt: Date.now() });
      applied.add(e.id);
      added++;
    }
  }
  if (added) {
    saveKb(kb);
    fs.writeFileSync(IMPORTS_APPLIED_FILE, JSON.stringify([...applied], null, 2));
    console.log(`Added ${added} knowledge base entr${added === 1 ? 'y' : 'ies'} from seed/imports`);
  }
})();
// Shared secret the Gmail script sends with each email. Generated once and kept on the volume, so it
// never has to be typed anywhere — admins copy the ready-made script from /admin.
const INBOUND_SECRET = process.env.INBOUND_SECRET || (() => {
  if (!fs.existsSync(INBOUND_SECRET_FILE)) fs.writeFileSync(INBOUND_SECRET_FILE, crypto.randomBytes(24).toString('hex'));
  return fs.readFileSync(INBOUND_SECRET_FILE, 'utf8').trim();
})();

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
function isStaff(req) { if (!REQUIRE_STAFF_PASSCODE) return true; const c = parseCookies(req); return verifyCookie(c.fdc_staff, 'staff'); }
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
// Runs the conversation, letting Claude call the program-search tool (a few rounds at most) before answering.
async function callAnthropic(instructions, messages) {
  const convo = messages.slice();
  for (let round = 0; round < 4; round++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 4096, system: instructions, tools: [PROGRAM_SEARCH_TOOL, WEBSITE_SEARCH_TOOL], messages: convo }),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('Anthropic API error', r.status, errText);
      throw new Error('upstream_error');
    }
    const data = await r.json();
    const content = data.content || [];
    if (data.stop_reason !== 'tool_use') {
      return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    }
    // Echo the assistant turn back unchanged, then answer every tool call in one user message.
    convo.push({ role: 'assistant', content });
    const toolResults = await Promise.all(content.filter((b) => b.type === 'tool_use').map(async (b) => {
      if (b.name === WEBSITE_SEARCH_TOOL.name) {
        const result = searchWebsite(b.input && b.input.query);
        console.log(`Website search: "${b.input && b.input.query}" -> ${result.error || result.results.length + ' pages'}`);
        return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(result), is_error: !!result.error };
      }
      if (b.name !== PROGRAM_SEARCH_TOOL.name) return { type: 'tool_result', tool_use_id: b.id, content: 'Unknown tool', is_error: true };
      try {
        const result = await searchPrograms(b.input && b.input.keyword);
        console.log(`Program search: "${b.input && b.input.keyword}" -> ${result.error || result.total_matches + ' sessions'}`);
        return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(result), is_error: !!result.error };
      } catch (err) {
        console.error('Program search error', err);
        return { type: 'tool_result', tool_use_id: b.id, content: 'Program search failed: ' + (err.message || err), is_error: true };
      }
    }));
    convo.push({ role: 'user', content: toolResults });
  }
  throw new Error('upstream_error');
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

// ---------- weekly website check ----------
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '–', mdash: '—', hellip: '…' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}
// Readable text from the page's <main> content (falls back to <body>), without menus/scripts.
function htmlToText(html) {
  // Some pages have no <main>; for those take everything to the LAST </body> (scripts can contain an
  // early "</body>" string that would otherwise cut the page off).
  const main = html.match(/<main[\s\S]*?<\/main>/i);
  const bodyStart = html.search(/<body/i), bodyEnd = html.lastIndexOf('</body>');
  const text = (main ? main[0] : bodyStart !== -1 && bodyEnd > bodyStart ? html.slice(bodyStart, bodyEnd) : html)
    .replace(/<(script|style|noscript|svg|header|footer|nav|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}
function loadWebReview() {
  if (!fs.existsSync(WEB_REVIEW_FILE)) return {};
  return JSON.parse(fs.readFileSync(WEB_REVIEW_FILE, 'utf8'));
}
function saveWebReview(r) {
  fs.writeFileSync(WEB_REVIEW_FILE, JSON.stringify(r, null, 2));
}
const PAGE_UA = 'Mozilla/5.0 (YMCA Front Desk Concierge weekly page check)';
async function sitemapUrls() {
  const r = await fetch(SITEMAP_URL, { headers: { 'user-agent': PAGE_UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('sitemap HTTP ' + r.status);
  const xml = await r.text();
  return [...xml.matchAll(/<loc>(?:<!\[CDATA\[)?\s*([^<\]\s]+)/g)].map((m) => m[1])
    .filter((u) => /^https:\/\/tucsonymca\.org\//.test(u) && !/\/product\//.test(u));
}
async function fetchPage(url) {
  const r = await fetch(url, { headers: { 'user-agent': PAGE_UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const html = await r.text();
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const title = decodeEntities(titleTag).replace(/\s*[-|–]\s*YMCA of Southern Arizona\s*$/i, '').trim();
  let text = htmlToText(html);
  // Trim the site-wide menu (everything up to "Account Login") and footer ("Follow Us On Our Socials!").
  const menuEnd = text.indexOf('Account Login\n');
  if (menuEnd !== -1 && menuEnd < 2500) text = text.slice(menuEnd + 'Account Login\n'.length);
  const footer = text.indexOf('Follow Us On Our Socials');
  if (footer !== -1) text = text.slice(0, footer);
  return { title, text: text.trim().slice(0, 30000) };
}

// Downloads every page (pinned + sitemap). With review=true, also has Claude look for out-of-date
// content and emails support. Only one run at a time; a second call just waits for the running one.
let webCheckRunning = null;
function checkWebSources({ review = false } = {}) {
  if (!webCheckRunning) {
    webCheckRunning = runWebCheck(review).catch((e) => console.error('Web page check error', e)).finally(() => { webCheckRunning = null; });
  }
  return webCheckRunning;
}
async function runWebCheck(review) {
  const pages = loadWebPages();
  let urls = [];
  try { urls = await sitemapUrls(); } catch (err) { console.error('Sitemap failed, checking pinned pages only —', err.message); }
  const pinned = new Map(WEB_SOURCES.map((s) => [s.url, s]));
  urls = [...new Set([...WEB_SOURCES.map((s) => s.url), ...urls])];
  const fresh = {};
  let changed = 0, failed = [];
  for (const url of urls) {
    const prev = pages[url] || {};
    try {
      const { title, text: raw } = await fetchPage(url);
      // A page that loads but has no real text is itself a website problem — reported in the review.
      const blank = raw.length < 100;
      const text = blank ? '' : raw;
      const hash = crypto.createHash('sha256').update(text).digest('hex');
      if (prev.hash && hash !== prev.hash) changed++;
      fresh[url] = { title: pinned.has(url) ? pinned.get(url).title : title || url, text, blank, hash, checkedAt: Date.now(), changedAt: hash !== prev.hash ? Date.now() : prev.changedAt, error: null };
    } catch (err) {
      // Keep the last good copy so answers keep working; just record the failure.
      fresh[url] = { ...prev, title: prev.title || (pinned.get(url) || {}).title || url, checkedAt: Date.now(), error: String(err.message || err) };
      failed.push(url);
    }
    await sleep(500); // be polite to tucsonymca.org
  }
  saveWebPages(fresh);
  const meta = loadWebReview();
  meta.crawledAt = Date.now(); meta.pageCount = urls.length; meta.failed = failed;
  saveWebReview(meta);
  console.log(`Website check: ${urls.length} pages downloaded, ${changed} changed, ${failed.length} failed`);
  if (review) await reviewWebsite(fresh);
}

// ---- weekly out-of-date review ----
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: 'The exact out-of-date text from the page' },
          problem: { type: 'string', description: 'One sentence: what is wrong and why' },
        },
        required: ['quote', 'problem'],
        additionalProperties: false,
      },
    },
  },
  required: ['issues'],
  additionalProperties: false,
};
function arizonaToday() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/Phoenix', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
async function reviewPage(url, page) {
  const instructions =
    `Today is ${arizonaToday()}. You are checking one page of the YMCA of Southern Arizona website (tucsonymca.org) for content that is out of date or contradicts itself, so the web team can fix it. ` +
    'Flag only clear problems: dates, seasons, events or deadlines that have already passed but are presented as upcoming or current; registration windows that have closed but are presented as open; a past year presented as current; ' +
    'the same fact stated two different ways on the page (for example two different prices or limits for the same thing); obvious placeholder or test content. ' +
    "Do not flag evergreen content, writing style, typos, or anything you are not sure about. Quote the page's exact text. Return an empty list if nothing is clearly out of date.";
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: 4096, system: instructions,
      output_config: { format: { type: 'json_schema', schema: REVIEW_SCHEMA } },
      messages: [{ role: 'user', content: `Page: ${page.title}\nURL: ${url}\n\n${page.text}` }],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error('Anthropic HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const data = await r.json();
  if (data.stop_reason === 'refusal' || data.stop_reason === 'max_tokens') throw new Error('review stopped: ' + data.stop_reason);
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text).issues || [];
}
async function reviewWebsite(pages) {
  if (DEMO_MODE) { console.log('Website review skipped (demo mode — no Anthropic key)'); return; }
  const meta = loadWebReview();
  const previouslySeen = new Set((meta.issues || []).flatMap((p) => p.items.map((i) => p.url + '|' + i.quote)));
  const entries = Object.entries(pages).filter(([, p]) => p.text);
  const results = [];
  let reviewFailures = 0;
  // Blank pages (skipping WordPress plugin archive pages like /etn-tags/).
  for (const [url, p] of Object.entries(pages)) {
    if (!p.blank || /\/etn[-_]/.test(url)) continue;
    const quote = '(page has no content)';
    results.push({ url, title: p.title, items: [{ quote, problem: 'This page loads but shows no text — it may be broken, unfinished, or should be removed.', isNew: !previouslySeen.has(url + '|' + quote) }] });
  }
  // A few pages at a time keeps a full review to a few minutes without hammering the API.
  let next = 0;
  await Promise.all([0, 1, 2].map(async () => {
    while (next < entries.length) {
      const [url, page] = entries[next++];
      try {
        const items = await reviewPage(url, page);
        if (items.length) results.push({ url, title: page.title, items: items.map((i) => ({ ...i, isNew: !previouslySeen.has(url + '|' + i.quote) })) });
      } catch (err) {
        reviewFailures++;
        console.error('Website review failed for', url, '—', err.message);
      }
    }
  }));
  results.sort((a, b) => a.title.localeCompare(b.title));
  const total = results.reduce((n, p) => n + p.items.length, 0);
  const newCount = results.reduce((n, p) => n + p.items.filter((i) => i.isNew).length, 0);
  Object.assign(meta, { reviewedAt: Date.now(), issues: results, reviewFailures, emailed: false });
  console.log(`Website review: ${total} possible out-of-date items on ${results.length} pages (${newCount} new), ${reviewFailures} pages couldn't be reviewed`);

  if (total && RESEND_API_KEY) {
    const html =
      `<p>The Front Desk Concierge checked all ${entries.length} pages on tucsonymca.org (${arizonaToday()}) and found ${total} item${total === 1 ? '' : 's'} on ${results.length} page${results.length === 1 ? '' : 's'} that may be out of date${newCount ? ` (${newCount} new since last week)` : ''}.</p>` +
      results.map((p) =>
        `<h3 style="margin:18px 0 6px"><a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a></h3><ul>` +
        p.items.map((i) => `<li>${i.isNew ? '<strong>[NEW]</strong> ' : ''}"${escapeHtml(i.quote)}"<br><span style="color:#555">${escapeHtml(i.problem)}</span></li>`).join('') +
        '</ul>').join('') +
      '<p style="color:#666;font-size:12px">Found by an automated review, so double-check before changing anything. This list is also in the concierge at /admin.</p>';
    try {
      await sendEmailViaResend(SUPPORT_EMAIL, `Website check: ${total} item${total === 1 ? '' : 's'} may be out of date${newCount ? ` (${newCount} new)` : ''}`, html);
      meta.emailed = true;
    } catch { /* logged by sendEmailViaResend; still visible in /admin */ }
  }
  saveWebReview(meta);
}

// Monday in Arizona (no daylight saving, so a fixed offset is safe via Intl).
function arizonaDay() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hour12: false }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { weekday: get('weekday'), date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}
function scheduleWebChecks() {
  const pages = loadWebPages();
  const meta = loadWebReview();
  const missing = !meta.crawledAt || WEB_SOURCES.some((s) => !pages[s.url] || !pages[s.url].text);
  const stale = Date.now() - (meta.crawledAt || 0) > 7 * 24 * 3600 * 1000;
  if (missing || stale) checkWebSources();
  setInterval(() => {
    const az = arizonaDay();
    const m = loadWebReview();
    // Remembered on disk so a restart on a Monday doesn't run (and email) twice.
    if (az.weekday === 'Mon' && az.hour >= 6 && m.lastMondayRun !== az.date) {
      m.lastMondayRun = az.date;
      saveWebReview(m);
      checkWebSources({ review: true });
    }
  }, 30 * 60 * 1000);
}
function webPagesText() {
  const pages = loadWebPages();
  return WEB_SOURCES.filter((s) => pages[s.url] && pages[s.url].text).map((s) => {
    const p = pages[s.url];
    const checked = new Date(p.checkedAt).toLocaleDateString('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric', year: 'numeric' });
    return `### ${p.title} (from the Y website: ${s.url} — checked ${checked})\n${p.text}`;
  }).join('\n\n');
}

// ---- search across every saved tucsonymca.org page ----
const SEARCH_STOPWORDS = new Set('the and for are you can how what when where who does our your with that this from have about there their any all ymca page'.split(' '));
function searchWebsite(query) {
  const pages = loadWebPages();
  const pinned = new Set(WEB_SOURCES.map((s) => s.url));
  const stems = [...new Set(String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !SEARCH_STOPWORDS.has(w)).map(wordStem))];
  if (!stems.length) return { error: 'empty search' };
  const scored = Object.entries(pages).filter(([url, p]) => p.text && !pinned.has(url)).map(([url, p]) => {
    const text = p.text.toLowerCase(), title = (p.title || '').toLowerCase();
    let score = 0, hits = 0;
    for (const st of stems) {
      const count = Math.min(10, text.split(st).length - 1);
      if (count || title.includes(st) || url.includes(st)) hits++;
      score += count + (title.includes(st) ? 8 : 0) + (url.includes(st) ? 5 : 0);
    }
    return { url, p, score: score * hits };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);
  return {
    results: scored.map(({ url, p }) => {
      // The lines that mention the search words, plus a line of context on each side.
      const lines = p.text.split('\n');
      const keep = new Set();
      lines.forEach((line, i) => { if (stems.some((st) => line.toLowerCase().includes(st))) [i - 1, i, i + 1, i + 2].forEach((j) => keep.add(j)); });
      let excerpt = [...keep].filter((i) => i >= 0 && i < lines.length).sort((a, b) => a - b).map((i) => lines[i]).join('\n');
      if (excerpt.length > 3500) excerpt = excerpt.slice(0, 3500) + '…';
      return { title: p.title, url, excerpt };
    }),
    note: 'Pinned pages (tax credit, sports) are already in the knowledge base and are not repeated here.',
  };
}
const WEBSITE_SEARCH_TOOL = {
  name: 'search_website',
  description:
    'Searches every page of the YMCA of Southern Arizona website (tucsonymca.org), re-downloaded every Monday. ' +
    'Returns the best-matching pages with their link and the relevant excerpts. Use short keyword queries, e.g. "family camp", "child care", "Holsclaw hours".',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Keywords to look for' } },
    required: ['query'],
    additionalProperties: false,
  },
};

// ---------- announcements from email (special events, closures, schedule changes) ----------
// A Google Apps Script in the concierge@tucsonymca.org mailbox posts each new email to /api/inbound-email.
// Claude pulls out anything staff should know, saved as announcements that the concierge uses until they expire.
const ANNOUNCEMENT_SCHEMA = {
  type: 'object',
  properties: {
    announcements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title, e.g. "Boo at the Pool movie night"' },
          category: { type: 'string', enum: ['event', 'closure', 'schedule change', 'program', 'policy', 'other'] },
          branches: { type: 'array', items: { type: 'string' }, description: 'Branches it applies to, e.g. ["Northwest YMCA"]; empty if all or unknown' },
          starts: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'YYYY-MM-DD the event/closure starts, or null' },
          ends: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'YYYY-MM-DD it ends (same as starts for one day), or null if ongoing/unknown' },
          details: { type: 'string', description: 'Everything front desk staff need: what, when (times), where, who it is for, cost, how to sign up, who to contact' },
        },
        required: ['title', 'category', 'branches', 'starts', 'ends', 'details'],
        additionalProperties: false,
      },
    },
  },
  required: ['announcements'],
  additionalProperties: false,
};
// PDFs and images from the email, passed to Claude so details that are only on a flyer get picked up.
const EMAIL_ATTACHMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'];
function attachmentBlocks(attachments) {
  return attachments.filter((a) => a.contentType === 'application/pdf' || a.bytes <= 5 * 1024 * 1024).map((a) =>
    a.contentType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } }
      : { type: 'image', source: { type: 'base64', media_type: a.contentType, data: a.data } });
}
async function extractAnnouncements(email, attachments = []) {
  const instructions =
    `Today is ${arizonaToday()}. You read emails sent or forwarded to the YMCA of Southern Arizona Front Desk Concierge and pull out information front desk staff should know when members ask: special events, facility or amenity closures, schedule or hours changes, new or changed programs, policy updates. ` +
    'Use the email date to resolve relative dates ("this Saturday"). Ignore signatures, disclaimers, and forwarding headers. Branch names: Lighthouse City, Lohse Family, Ott Family, Northwest (Pima County Community Center), Jacobs City, Mulcahy City, Holsclaw, Triangle Y Camp. ' +
    'Only include facts stated in the email or its attached flyers/images (read them — flyers often have the date, time, cost and sign-up details). Return an empty list if the email has nothing staff would need to tell members (e.g. a thank-you note or an internal-only reply).';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: 4096, system: instructions,
      output_config: { format: { type: 'json_schema', schema: ANNOUNCEMENT_SCHEMA } },
      messages: [{ role: 'user', content: [...attachmentBlocks(attachments), { type: 'text', text: `From: ${email.from}\nDate: ${email.date}\nSubject: ${email.subject}\n\n${email.body}` }] }],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error('Anthropic HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const data = await r.json();
  if (data.stop_reason === 'refusal' || data.stop_reason === 'max_tokens') throw new Error('extraction stopped: ' + data.stop_reason);
  return JSON.parse((data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')).announcements || [];
}
// Announcement flyers to show under an answer: ones whose title the answer (or question) mentions.
function relatedAnnouncementFlyers(question, answer) {
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const q = norm(question), ans = norm(answer);
  const out = [];
  for (const a of loadAnnouncements().entries) {
    if (a.status !== 'live' || !announcementActive(a) || !(a.attachments || []).length) continue;
    const title = norm(a.title);
    const words = title.split(' ').filter((w) => w.length > 3);
    const inQuestion = words.length && words.filter((w) => q.includes(w)).length >= Math.ceil(words.length / 2);
    if (!(ans.includes(title) || inQuestion)) continue;
    for (const f of a.attachments) out.push({ id: a.id, title: a.title, filename: f.filename, url: '/uploads/' + f.path });
  }
  return out;
}
function arizonaISODate(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' }); // YYYY-MM-DD
}
// Live until the day after it ends; with no end date, until 60 days after the email arrived.
function announcementActive(a) {
  const today = arizonaISODate(Date.now());
  if (a.ends) return a.ends >= today;
  if (a.starts && a.starts >= today) return true;
  return Date.now() - a.receivedAt < 60 * 24 * 3600 * 1000;
}
function announcementsText() {
  const live = loadAnnouncements().entries.filter((a) => a.status === 'live' && announcementActive(a));
  if (!live.length) return '';
  return live.map((a) => {
    const when = a.starts ? (a.ends && a.ends !== a.starts ? `${a.starts} to ${a.ends}` : a.starts) : 'no specific date';
    const received = new Date(a.receivedAt).toLocaleDateString('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric' });
    const flyer = a.attachments && a.attachments.length ? ' (flyer attached)' : '';
    return `### ${a.title}${flyer} (${a.category}; ${a.branches.length ? a.branches.join(', ') : 'all/unspecified branches'}; ${when}) — from an email received ${received}\n${a.details}`;
  }).join('\n\n');
}
function gmailScript() {
  return `// Front Desk Concierge — sends new emails in this mailbox to the concierge every 5 minutes.
// Paste into script.google.com while signed in as concierge@tucsonymca.org, then run "setup" once.
const CONCIERGE_URL = '${PUBLIC_URL}/api/inbound-email';
const SECRET = '${INBOUND_SECRET}';
const DONE_LABEL = 'Concierge Processed';

function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendNewEmails').timeBased().everyMinutes(5).create();
  sendNewEmails();
}

function sendNewEmails() {
  const done = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  const threads = GmailApp.search('in:inbox -label:concierge-processed newer_than:30d', 0, 20);
  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const res = UrlFetchApp.fetch(CONCIERGE_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-concierge-secret': SECRET },
        payload: JSON.stringify({
          messageId: msg.getId(), from: msg.getFrom(), subject: msg.getSubject(),
          date: msg.getDate().toISOString(), body: msg.getPlainBody().slice(0, 100000),
          // Flyers: PDFs and images (skipping small ones like signature logos), up to 5 per email.
          attachments: msg.getAttachments({ includeInlineImages: true })
            .filter((a) => /^(application\\/pdf|image\\/(png|jpeg|gif|webp))$/.test(a.getContentType()) && a.getSize() > 20000 && a.getSize() < 15000000)
            .slice(0, 5)
            .map((a) => ({ filename: a.getName(), contentType: a.getContentType(), data: Utilities.base64Encode(a.getBytes()) })),
        }),
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() !== 200) {
        console.log('Concierge did not accept "' + msg.getSubject() + '": ' + res.getResponseCode() + ' ' + res.getContentText());
        return; // try again on the next run
      }
    }
    thread.addLabel(done);
  }
}
`;
}

// ---------- live program search (Daxko online registration) ----------
// Uses the same public search the Daxko "Program Search" page runs in the browser (no login needed).
// Daxko matches ANY word in the keywords, so every search is expanded into variants (e.g. "volleyball",
// "youth volleyball", "adult volleyball"), merged, then filtered down to sessions containing every word
// staff asked about.
const DAXKO_BASE = 'https://operations.daxko.com/Online/5242/ProgramsV2';
// Extra words to also search with. Keyed by activity; everything else gets DEFAULT_SEARCH_MODIFIERS.
const DEFAULT_SEARCH_MODIFIERS = ['youth', 'adult'];
const SEARCH_MODIFIERS = {
  swim: ['private', 'group', 'youth', 'adult'],
};
const DAXKO_MAX_PAGES = 3; // 20 sessions per page
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Daxko needs a session cookie: the first visit sets one and redirects back to itself (Node's fetch
// doesn't keep cookies, so without this it loops). Daxko also rate-limits bursts (HTTP 429), so
// requests go one at a time with a short gap and one retry.
let daxkoCookie = { value: '', at: 0 };
let daxkoLast = 0;
async function daxkoPaced(url, opts) {
  const wait = daxkoLast + 400 - Date.now();
  if (wait > 0) await sleep(wait);
  daxkoLast = Date.now();
  return fetch(url, { ...opts, redirect: 'manual', signal: AbortSignal.timeout(20000) });
}
async function daxkoSession(force) {
  if (!force && daxkoCookie.value && Date.now() - daxkoCookie.at < 15 * 60 * 1000) return daxkoCookie.value;
  const jar = new Map();
  let url = `${DAXKO_BASE}/Home.mvc`;
  for (let hop = 0; hop < 5; hop++) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await daxkoPaced(url, { headers: { 'user-agent': 'Mozilla/5.0 (YMCA Front Desk Concierge)', ...(cookie ? { cookie } : {}) } });
    for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : []) {
      const [pair] = c.split(';'); const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    if (r.status < 300 || r.status >= 400) break;
    url = new URL(r.headers.get('location'), url).toString();
  }
  daxkoCookie = { value: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), at: Date.now() };
  return daxkoCookie.value;
}
async function daxkoFetch(url, opts) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cookie = await daxkoSession(attempt > 0);
    const r = await daxkoPaced(url, { ...opts, headers: { ...opts.headers, cookie } });
    if (r.status === 429) { await sleep(2000); continue; }
    if (r.status >= 300 && r.status < 400) continue; // session expired — get a fresh cookie and retry
    return r;
  }
  throw new Error('Daxko search unavailable (rate limited or session refused)');
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function parseDaxkoOfferings(html) {
  return html.split('<li class="programResults__list-item').slice(1).map((li) => {
    const attr = (name) => { const m = li.match(new RegExp(name + '="([^"]*)"')); return m ? m[1] : ''; };
    const href = decodeEntities(attr('href'));
    const ids = {};
    for (const k of ['program_id', 'offering_id', 'location_id']) { const m = href.match(new RegExp(k + '=([^&]+)')); ids[k] = m ? m[1] : ''; }
    const dates = li.match(/class="pull-left">([\s\S]*?)<\/div>\s*<\/div>/);
    const times = li.match(/class="pull-right">([\s\S]*?)<\/div>/);
    const after = li.split(/programResults__date-details/)[1] || '';
    const desc = after.match(/<\/div>\s*<\/div>\s*<div>([\s\S]*?)<\/div>/);
    const h5 = li.match(/<h5>([\s\S]*?)<\/h5>/);
    return {
      id: ids.offering_id + '@' + ids.location_id,
      program: stripTags(h5 ? h5[1] : attr('data-enh-ec-program-name')),
      session: stripTags(attr('data-enh-ec-name')),
      location: stripTags(attr('data-enh-ec-location')),
      dates: dates ? stripTags(dates[1]) : '',
      schedule: times ? stripTags(times[1]).replace(/\s*@\s*/, ' @ ') : '',
      description: desc ? stripTags(desc[1]) : '',
      register: ids.offering_id ? `${DAXKO_BASE}/OfferingDetails.mvc?program_id=${ids.program_id}&offering_id=${ids.offering_id}&location_id=${ids.location_id}` : '',
    };
  });
}
const daxkoCache = new Map(); // keywords -> { at, offerings }
async function daxkoSearchOnce(keywords) {
  const hit = daxkoCache.get(keywords);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.offerings;
  const headers = { 'user-agent': 'Mozilla/5.0 (YMCA Front Desk Concierge)', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams({ keywords }).toString();
  const r = await daxkoFetch(`${DAXKO_BASE}/Search.mvc/results`, { method: 'POST', headers, body });
  if (!r.ok) throw new Error('Daxko HTTP ' + r.status);
  const first = await r.json();
  let html = first.results || '';
  const offerings = parseDaxkoOfferings(html);
  let after = (html.match(/id="after" value="([^"]*)"/) || [])[1];
  for (let page = 1; after && page < DAXKO_MAX_PAGES; page++) {
    const n = await daxkoFetch(`${DAXKO_BASE}/Search.mvc/next_page?after=${encodeURIComponent(after)}`, { method: 'POST', headers, body });
    if (!n.ok) break;
    const next = await n.json();
    offerings.push(...parseDaxkoOfferings(next.offerings || ''));
    after = next.after;
  }
  daxkoCache.set(keywords, { at: Date.now(), offerings });
  return offerings;
}
// "lessons" should match "lesson", "swimming" should match "swim"
function wordStem(w) { return w.replace(/(ming|ing|es|s)$/, '') || w; }
async function searchPrograms(keyword) {
  const term = String(keyword || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!term) return { error: 'empty keyword' };
  const words = term.split(' ');
  const activity = Object.keys(SEARCH_MODIFIERS).find((k) => words.some((w) => w.startsWith(k)));
  const modifiers = activity ? SEARCH_MODIFIERS[activity] : DEFAULT_SEARCH_MODIFIERS;
  const coreWords = words.filter((w) => !modifiers.includes(w) && !DEFAULT_SEARCH_MODIFIERS.includes(w));
  const core = coreWords.join(' ') || term;
  const queries = [...new Set([term, core, ...modifiers.filter((m) => !words.includes(m)).map((m) => `${m} ${core}`)])];
  const results = [];
  for (const q of queries) results.push(await daxkoSearchOnce(q).catch((e) => { console.error('Daxko search failed', q, e.message); return null; }));
  if (results.every((r) => r === null)) return { error: 'Daxko program search is not responding right now' };
  const seen = new Map();
  for (const list of results) for (const o of list || []) if (!seen.has(o.id)) seen.set(o.id, o);
  // Keep only sessions that mention every word staff asked about (both words in "youth basketball").
  const stems = words.map(wordStem);
  const matches = [...seen.values()].filter((o) => {
    const text = `${o.program} ${o.session} ${o.description}`.toLowerCase();
    return stems.every((s) => text.includes(s));
  });
  return { searched_for: queries, total_matches: matches.length, sessions: matches.slice(0, 40) };
}

const PROGRAM_SEARCH_TOOL = {
  name: 'search_daxko_programs',
  description:
    "Searches the Y's live Daxko online registration for current program sessions (classes, lessons, leagues, camps, clubs). " +
    'Returns each matching session with program name, session name, branch, dates, days/times, a short description, and a registration link. ' +
    'Pass the activity the way staff asked about it, e.g. "volleyball", "swim lessons", "adult volleyball", "tumbling". ' +
    'The search automatically also covers youth/adult versions (and private/group for swim).',
  input_schema: {
    type: 'object',
    properties: { keyword: { type: 'string', description: 'Activity or program to look for, e.g. "swim lessons"' } },
    required: ['keyword'],
    additionalProperties: false,
  },
};

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

route('POST', '/api/chat', async (req, res, params, ip) => {
  if (!isStaff(req) && !isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  if (!isAdmin(req) && rateLimited(ip, 'chat', 60)) return sendJson(res, 429, { error: 'rate_limited' });
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
    `Today is ${arizonaToday()}. ` +
    'You are the Front Desk Concierge assistant for YMCA of Southern Arizona. ' +
    'Front-line staff are asking you questions while a member is at the counter, so answer briefly and plainly, leading with the direct answer. ' +
    "Only use the knowledge base below and your search tools. If the knowledge base doesn't cover a question, use search_website to look across the whole tucsonymca.org site before giving up, and include the page link when you use it. If neither has the answer, say clearly that it isn't in the saved knowledge base or on the website, and suggest using Ask Support — never guess at hours, prices, or policy. " +
    "If two saved answers disagree (for example older prices vs. a newer SOP with effective dates), follow the newer one, use the rates in effect on today's date, and mention upcoming changes. " +
    "Some entries are marked '(flyer attached)' — if one of those is relevant, mention that a flyer is available so staff know to show or print it. " +
    "Entries marked '(from the Y website …)' are the current text of a tucsonymca.org page, re-checked weekly; when you use one, include that page's link so staff can share it. " +
    "If a website page contradicts itself or a saved answer (for example two different dollar amounts), say so plainly and give both figures rather than picking one. " +
    "For ANY sports question (leagues, clinics, basketball, volleyball, soccer, adult sports, coaching), use the tucsonymca.org sports pages below as the main source — the Youth Sports Leagues page's 'Upcoming Season Information' section has the next seasons (dates, grades, registration windows, fees). Also run search_daxko_programs to see if sessions are open right now; if Daxko shows none, answer from the sports pages (e.g. when the next season and its registration open) instead of just saying nothing is available. " +
    "When staff ask what programs, classes, lessons, leagues or sessions are offered (or when/where one is), use the search_daxko_programs tool — that's the live registration system — and list the matching sessions: program, branch, dates, days/times, and the registration link. Group them by program and branch so they're easy to scan. " +
    "If the search finds nothing, say nothing is currently open for online registration in Daxko and point to the right department contact from the knowledge base. Don't list sessions that don't match what was asked.\n\n" +
    "Entries under ANNOUNCEMENTS come from recent staff and member emails (events, closures, schedule changes); they are newer than the website, so prefer them when they conflict, and mention the date.\n\n" +
    `=== KNOWLEDGE BASE ===\n${kbText(kb)}${webPagesText() ? '\n\n' + webPagesText() : ''}\n=== END KNOWLEDGE BASE ===` +
    (announcementsText() ? `\n\n=== ANNOUNCEMENTS (from emails) ===\n${announcementsText()}\n=== END ANNOUNCEMENTS ===` : '');
  const messages = [];
  if (Array.isArray(body.history)) {
    for (const h of body.history.slice(-12)) {
      if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') messages.push({ role: h.role, content: h.content });
    }
  }
  messages.push({ role: 'user', content: body.question });

  try {
    const answer = await callAnthropic(instructions, messages);
    const seen = new Set(flyers.map((f) => f.url));
    for (const f of relatedAnnouncementFlyers(body.question, answer)) if (!seen.has(f.url)) { seen.add(f.url); flyers.push(f); }
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
  if (!question || !name || !clip(body.topic, 120)) return sendJson(res, 400, { error: 'missing_fields' });
  const entry = {
    id: newId(), question, name,
    topic: clip(body.topic, 120),
    createdAt: Date.now(), handled: false, emailed: false,
  };

  if (RESEND_API_KEY) {
    const row = (label, val) => val ? `<p><strong>${label}:</strong><br>${escapeHtml(val).replace(/\n/g, '<br>')}</p>` : '';
    const html =
      "<p>A front desk staff member asked a question the Front Desk Concierge couldn't answer.</p>" +
      row('Topic', entry.topic) + row('Question', entry.question) + row('From', entry.name) +
      '<p style="color:#666;font-size:12px">Once it&#39;s answered, add it to the knowledge base at /admin so the concierge can answer it next time.</p>';
    try {
      await sendEmailViaResend(SUPPORT_EMAIL, 'Front desk question (' + entry.topic + '): ' + entry.question.slice(0, 80), html);
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

route('GET', '/api/admin/web-pages', async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  const pages = loadWebPages();
  const meta = loadWebReview();
  sendJson(res, 200, {
    running: !!webCheckRunning,
    crawledAt: meta.crawledAt || null, pageCount: meta.pageCount || 0, failed: meta.failed || [],
    reviewedAt: meta.reviewedAt || null, reviewFailures: meta.reviewFailures || 0, emailed: !!meta.emailed, issues: meta.issues || [],
    pinned: WEB_SOURCES.map((s) => {
      const p = pages[s.url] || {};
      return { url: s.url, title: s.title, checkedAt: p.checkedAt || null, changedAt: p.changedAt || null, error: p.error || null };
    }),
  });
});
// Starts a full download + out-of-date review in the background (takes a few minutes).
route('POST', '/api/admin/web-pages/check', async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  checkWebSources({ review: true });
  sendJson(res, 200, { ok: true, started: true });
});

function saveEmailAttachments(attachments) {
  return attachments.map((a) => {
    const storedName = `${newId()}-${a.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, storedName), Buffer.from(a.data, 'base64'));
    return { filename: a.filename, path: storedName, contentType: a.contentType };
  });
}
// Called by the Gmail Apps Script (see gmailScript()) for each new email in the concierge mailbox.
route('POST', '/api/inbound-email', async (req, res) => {
  const given = String(req.headers['x-concierge-secret'] || '');
  const ok = given.length === INBOUND_SECRET.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(INBOUND_SECRET));
  if (!ok) return sendJson(res, 401, { error: 'bad_secret' });
  const body = await readJsonBody(req, 80 * 1024 * 1024).catch(() => null);
  if (!body || !body.messageId || typeof body.body !== 'string') return sendJson(res, 400, { error: 'missing_fields' });
  const attachments = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 5)
    .filter((a) => a && EMAIL_ATTACHMENT_TYPES.includes(a.contentType) && typeof a.data === 'string')
    .map((a) => ({ filename: String(a.filename || 'flyer').slice(0, 150), contentType: a.contentType, data: a.data, bytes: Math.floor(a.data.length * 3 / 4) }))
    .filter((a) => a.bytes <= 15 * 1024 * 1024);
  const store = loadAnnouncements();
  if (store.emailIds.includes(body.messageId)) {
    // Seen before — but if it now comes with flyers (e.g. re-sent after the script learned to send them),
    // add them to this email's announcements that don't have any yet.
    const bare = store.entries.filter((e) => e.emailId === body.messageId && !(e.attachments || []).length);
    if (attachments.length && bare.length) {
      const saved = saveEmailAttachments(attachments);
      bare.forEach((e) => { e.attachments = saved; });
      saveAnnouncements(store);
      console.log(`Added ${saved.length} flyer(s) to ${bare.length} announcement(s) from "${body.subject}"`);
      return sendJson(res, 200, { ok: true, attachmentsAdded: saved.length });
    }
    return sendJson(res, 200, { ok: true, duplicate: true });
  }
  if (DEMO_MODE) return sendJson(res, 503, { error: 'demo_mode' });
  const email = { from: String(body.from || ''), subject: String(body.subject || ''), date: String(body.date || ''), body: body.body.slice(0, 100000) };
  let found;
  try { found = await extractAnnouncements(email, attachments); } catch (err) {
    console.error('Announcement extraction failed', err.message);
    return sendJson(res, 502, { error: 'extraction_failed' }); // the script retries on its next run
  }
  const address = (email.from.match(/<([^>]+)>/) || [, email.from])[1].trim().toLowerCase();
  const trusted = TRUSTED_EMAIL_DOMAINS.some((d) => address.endsWith('@' + d));
  const fresh = loadAnnouncements(); // re-read: another email may have been saved meanwhile
  // Files are written only once something actually uses them (a repeat email adds nothing new).
  let saved = null;
  const files = () => (saved = saved || saveEmailAttachments(attachments));
  for (const a of found) {
    const dup = fresh.entries.find((e) => announcementKey(e) === announcementKey(a));
    if (dup) { // already have it from an earlier copy of this email — just add flyers if it had none
      if (attachments.length && !(dup.attachments || []).length) dup.attachments = files();
      continue;
    }
    fresh.entries.push({ id: newId(), ...a, attachments: attachments.length ? files() : [], status: trusted ? 'live' : 'pending', from: email.from, subject: email.subject, emailId: body.messageId, receivedAt: Date.now() });
  }
  fresh.emailIds.push(body.messageId);
  saveAnnouncements(fresh);
  console.log(`Inbound email "${email.subject}" from ${address}: ${found.length} announcement(s), ${saved ? saved.length : 0} flyer(s) saved, ${trusted ? 'live' : 'awaiting approval'}`);
  sendJson(res, 200, { ok: true, announcements: found.length });
});
route('GET', '/api/admin/announcements', async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  const entries = loadAnnouncements().entries.map((a) => ({ ...a, active: announcementActive(a) }))
    .sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || b.receivedAt - a.receivedAt);
  sendJson(res, 200, { entries, emailsReceived: loadAnnouncements().emailIds.length });
});
route('GET', '/api/admin/email-setup', async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  sendJson(res, 200, { script: gmailScript() });
});
route('PUT', '/api/admin/announcements/:id', async (req, res, params) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  const store = loadAnnouncements();
  const a = store.entries.find((e) => e.id === params.id);
  if (!a) return sendJson(res, 404, { error: 'not_found' });
  a.status = 'live';
  saveAnnouncements(store);
  sendJson(res, 200, a);
});
route('DELETE', '/api/admin/announcements/:id', async (req, res, params) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  const store = loadAnnouncements();
  const removed = store.entries.find((e) => e.id === params.id);
  store.entries = store.entries.filter((e) => e.id !== params.id);
  saveAnnouncements(store);
  const stillUsed = new Set(store.entries.flatMap((e) => (e.attachments || []).map((f) => f.path)));
  for (const f of (removed && removed.attachments) || []) {
    const p = path.join(UPLOADS_DIR, f.path);
    if (!stillUsed.has(f.path) && fs.existsSync(p)) fs.unlinkSync(p);
  }
  sendJson(res, 200, { ok: true });
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
  res.setHeader('X-Robots-Tag', 'noindex, nofollow'); // staff tool — keep it out of search engines
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

scheduleWebChecks();

server.listen(PORT, () => {
  console.log(`Front Desk Concierge listening on :${PORT}${DEMO_MODE ? ' (DEMO MODE)' : ''}`);
});
