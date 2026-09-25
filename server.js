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

// Pages on tucsonymca.org the concierge reads directly. Re-checked every Monday morning (Arizona time);
// the latest text is included alongside the saved answers. Add a page here to have it checked too.
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
function loadWebPages() {
  if (!fs.existsSync(WEB_PAGES_FILE)) return {};
  return JSON.parse(fs.readFileSync(WEB_PAGES_FILE, 'utf8'));
}
function saveWebPages(p) {
  fs.writeFileSync(WEB_PAGES_FILE, JSON.stringify(p, null, 2));
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
// Runs the conversation, letting Claude call the program-search tool (a few rounds at most) before answering.
async function callAnthropic(instructions, messages) {
  const convo = messages.slice();
  for (let round = 0; round < 4; round++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 4096, system: instructions, tools: [PROGRAM_SEARCH_TOOL], messages: convo }),
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
  const main = html.match(/<main[\s\S]*?<\/main>/i) || html.match(/<body[\s\S]*?<\/body>/i);
  const text = (main ? main[0] : html)
    .replace(/<(script|style|noscript|svg|header|footer|nav|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}
async function checkWebSources() {
  const pages = loadWebPages();
  for (const src of WEB_SOURCES) {
    const prev = pages[src.url] || {};
    try {
      const r = await fetch(src.url, { headers: { 'user-agent': 'Mozilla/5.0 (YMCA Front Desk Concierge weekly page check)' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      let text = htmlToText(await r.text());
      const menuEnd = text.indexOf('Account Login\n');
      if (menuEnd !== -1 && menuEnd < 2500) text = text.slice(menuEnd + 'Account Login\n'.length);
      const footer = text.indexOf('Follow Us On Our Socials');
      if (footer !== -1) text = text.slice(0, footer);
      text = text.trim().slice(0, 30000);
      if (text.length < 200) throw new Error('page came back nearly empty');
      const hash = crypto.createHash('sha256').update(text).digest('hex');
      const changed = hash !== prev.hash;
      pages[src.url] = { title: src.title, text, hash, checkedAt: Date.now(), changedAt: changed ? Date.now() : prev.changedAt, error: null };
      console.log(`Web page check: ${src.url} — ${prev.hash ? (changed ? 'CHANGED' : 'no change') : 'first copy saved'}`);
    } catch (err) {
      // Keep the last good copy so answers keep working; just record the failure.
      pages[src.url] = { ...prev, title: src.title, checkedAt: Date.now(), error: String(err.message || err) };
      console.error(`Web page check failed: ${src.url} — ${err.message || err}`);
    }
  }
  saveWebPages(pages);
}
// Monday in Arizona (no daylight saving, so a fixed offset is safe via Intl).
function arizonaDay() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hour12: false }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { weekday: get('weekday'), date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}
let lastMondayCheck = null;
function scheduleWebChecks() {
  const pages = loadWebPages();
  const missing = WEB_SOURCES.some((s) => !pages[s.url] || !pages[s.url].text);
  const stale = WEB_SOURCES.some((s) => pages[s.url] && Date.now() - (pages[s.url].checkedAt || 0) > 7 * 24 * 3600 * 1000);
  if (missing || stale) checkWebSources().catch((e) => console.error('Web page check error', e));
  setInterval(() => {
    const az = arizonaDay();
    if (az.weekday === 'Mon' && az.hour >= 6 && lastMondayCheck !== az.date) {
      lastMondayCheck = az.date;
      checkWebSources().catch((e) => console.error('Web page check error', e));
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
    "Some entries are marked '(flyer attached)' — if one of those is relevant, mention that a flyer is available so staff know to show or print it. " +
    "Entries marked '(from the Y website …)' are the current text of a tucsonymca.org page, re-checked weekly; when you use one, include that page's link so staff can share it. " +
    "If a website page contradicts itself or a saved answer (for example two different dollar amounts), say so plainly and give both figures rather than picking one. " +
    "For ANY sports question (leagues, clinics, basketball, volleyball, soccer, adult sports, coaching), use the tucsonymca.org sports pages below as the main source — the Youth Sports Leagues page's 'Upcoming Season Information' section has the next seasons (dates, grades, registration windows, fees). Also run search_daxko_programs to see if sessions are open right now; if Daxko shows none, answer from the sports pages (e.g. when the next season and its registration open) instead of just saying nothing is available. " +
    "When staff ask what programs, classes, lessons, leagues or sessions are offered (or when/where one is), use the search_daxko_programs tool — that's the live registration system — and list the matching sessions: program, branch, dates, days/times, and the registration link. Group them by program and branch so they're easy to scan. " +
    "If the search finds nothing, say nothing is currently open for online registration in Daxko and point to the right department contact from the knowledge base. Don't list sessions that don't match what was asked.\n\n" +
    `=== KNOWLEDGE BASE ===\n${kbText(kb)}${webPagesText() ? '\n\n' + webPagesText() : ''}\n=== END KNOWLEDGE BASE ===`;
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
  sendJson(res, 200, WEB_SOURCES.map((s) => {
    const p = pages[s.url] || {};
    return { url: s.url, title: s.title, checkedAt: p.checkedAt || null, changedAt: p.changedAt || null, error: p.error || null, chars: p.text ? p.text.length : 0 };
  }));
});
route('POST', '/api/admin/web-pages/check', async (req, res) => {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'not_authenticated' });
  await checkWebSources();
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
