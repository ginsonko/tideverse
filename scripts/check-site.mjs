#!/usr/bin/env node
// Site checker for the public repository.
//
//   node scripts/check-site.mjs                 static checks + live download links + headless browser checks
//   node scripts/check-site.mjs --static        static checks only (no browser, no network); add --live to probe links
//   node scripts/check-site.mjs --offline       everything except the live download-link probe
//   node scripts/check-site.mjs --sync          regenerate site/assets/js/config-fallback.js from site/config.json
//   node scripts/check-site.mjs --shots DIR     where to write screenshots (default: ./dist/shots)
//   node scripts/check-site.mjs --site DIR      check an unpacked partner package (folder with index.html)
//
// Browser checks need playwright-core and a local Chrome / Edge. Override with
// PLAYWRIGHT_CORE=<path to playwright-core> and CHROME_PATH=<browser exe>.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
// --site DIR checks an unpacked partner package instead of this repository.
const SITE_ARG = opt('--site', '');
const ROOT = SITE_ARG ? path.resolve(SITE_ARG) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = SITE_ARG ? ROOT : path.join(ROOT, 'site');
const CONFIG = path.join(SITE, 'config.json');
const FALLBACK = path.join(SITE, 'assets', 'js', 'config-fallback.js');

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};

export function fallbackSource(cfgText) {
  const cfg = JSON.parse(cfgText);
  return (
    '/* Generated from site/config.json by scripts/check-site.mjs --sync. Do not edit by hand.\n' +
    '   Used only when the page is opened from file://, where browsers block reading config.json. */\n' +
    `window.__OC_CONFIG_FALLBACK__ = ${JSON.stringify(cfg, null, 2)};\n`
  );
}

if (flag('--sync')) {
  fs.writeFileSync(FALLBACK, fallbackSource(fs.readFileSync(CONFIG, 'utf8')), 'utf8');
  console.log(`wrote ${path.relative(ROOT, FALLBACK)}`);
  process.exit(0);
}

/* ---------- 1. forbidden brand strings ---------- */
// Stored escaped so this file does not trip its own scan.
const FORBIDDEN_TEXT = ['\u94f6\u5b50'];
const FORBIDDEN_ASCII = ['yin' + 'zi'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function checkForbidden() {
  console.log('\n[1] No forbidden brand strings (text, binary, file names)');
  const files = walk(ROOT);
  const needles = [
    ...FORBIDDEN_TEXT.map((s) => ({ label: 'CJK brand', bytes: Buffer.from(s, 'utf8'), ci: false })),
    ...FORBIDDEN_ASCII.map((s) => ({ label: 'ASCII brand', bytes: Buffer.from(s, 'latin1'), ci: true })),
  ];
  let hits = 0;
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const nameLower = rel.toLowerCase();
    if (FORBIDDEN_TEXT.some((s) => rel.includes(s)) || FORBIDDEN_ASCII.some((s) => nameLower.includes(s))) {
      fail(`file name contains a forbidden string: ${rel}`);
      hits++;
    }
    const buf = fs.readFileSync(f);
    const lower = Buffer.from(buf.toString('latin1').toLowerCase(), 'latin1');
    // UTF-16LE copies are checked too, in case a tool wrote metadata that way.
    for (const n of needles) {
      const hay = n.ci ? lower : buf;
      const found = hay.indexOf(n.bytes) !== -1 || buf.indexOf(Buffer.from(n.bytes.toString(n.ci ? 'latin1' : 'utf8'), 'utf16le')) !== -1;
      if (found) {
        fail(`${rel} contains a forbidden ${n.label} string`);
        hits++;
      }
    }
  }
  if (!hits) ok(`${files.length} files scanned, none contain forbidden strings`);
}

/* ---------- 2. local links and assets ---------- */
function htmlFiles() {
  return walk(SITE).filter((f) => f.endsWith('.html'));
}

function checkLinks() {
  console.log('\n[2] Local links and assets resolve');
  let count = 0;
  const check = (from, ref, ids) => {
    if (!ref || /^(https?:|mailto:|tel:|data:|javascript:)/i.test(ref) || ref.startsWith('//')) return;
    count++;
    const [pathPart, hash] = ref.split('#');
    if (!pathPart) {
      if (hash && ids && !ids.has(decodeURIComponent(hash))) fail(`${path.relative(ROOT, from)}: anchor #${hash} not found`);
      return;
    }
    const target = path.resolve(path.dirname(from), decodeURIComponent(pathPart.split('?')[0]));
    if (!target.startsWith(SITE)) return fail(`${path.relative(ROOT, from)}: ${ref} points outside site/`);
    const exists = fs.existsSync(target) && (fs.statSync(target).isFile() || fs.existsSync(path.join(target, 'index.html')));
    if (!exists) fail(`${path.relative(ROOT, from)}: missing ${ref}`);
  };
  for (const f of htmlFiles()) {
    const html = fs.readFileSync(f, 'utf8');
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/\s(?:href|src|poster)="([^"]*)"/g)) check(f, m[1], ids);
    for (const m of html.matchAll(/content="([^"]+\.(?:png|jpe?g|webp))"/g)) check(f, m[1], ids);
  }
  for (const f of walk(SITE).filter((x) => x.endsWith('.css'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) check(f, m[1]);
  }
  const manifest = path.join(SITE, 'site.webmanifest');
  if (fs.existsSync(manifest)) for (const i of JSON.parse(fs.readFileSync(manifest, 'utf8')).icons || []) check(manifest, i.src);
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  for (const v of cfg.videos || []) for (const p of [v.poster, v.poster_portrait]) if (p) check(CONFIG, p);
  if (cfg.partner && cfg.partner.logo && !/^https?:/i.test(cfg.partner.logo)) check(CONFIG, cfg.partner.logo);
  if (!failures) ok(`${count} local references resolve`);
}

/* ---------- 3. config.json schema ---------- */
export function validateConfig(cfg) {
  const errs = [];
  const str = (v, p, { required = true, url = false, allowTodo = false } = {}) => {
    if (v === undefined || v === null) return required ? errs.push(`${p} is missing`) : undefined;
    if (typeof v !== 'string') return errs.push(`${p} must be a string`);
    if (required && !v.trim()) return errs.push(`${p} must not be empty`);
    if (/^TODO/i.test(v) && !allowTodo) return errs.push(`${p} is still TODO`);
    if (url && v && !/^TODO/i.test(v) && !/^https?:\/\/\S+$/i.test(v) && !/^[\w./-][^:]*$/.test(v)) errs.push(`${p} must be an http(s) URL or a relative path`);
  };
  if (cfg.schema !== 1) errs.push('schema must be 1');
  const p = cfg.product || {};
  str(p.name, 'product.name');
  if (p.name && p.name !== '万能创作终端') errs.push('product.name must stay 万能创作终端');
  str(p.english_name, 'product.english_name');
  str(p.tagline, 'product.tagline');
  for (const k of ['repo', 'issues', 'manual_general', 'manual_smart']) str(p[k], `product.${k}`, { url: true });
  const r = cfg.release || {};
  str(r.version, 'release.version');
  if (r.version && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(r.version)) errs.push('release.version must look like 1.2.3');
  str(r.channel, 'release.channel', { required: false });
  str(r.date, 'release.date', { required: false, allowTodo: true });
  str(r.release_page, 'release.release_page', { url: true });
  str(r.mirror_note, 'release.mirror_note', { required: false });
  const assets = r.assets || {};
  const need = ['win_setup', 'win_portable', 'mac_arm64', 'mac_x64'];
  for (const id of need) if (!assets[id]) errs.push(`release.assets.${id} is missing`);
  for (const [id, a] of Object.entries(assets)) {
    const b = `release.assets.${id}`;
    str(a.label, `${b}.label`);
    str(a.note, `${b}.note`, { required: false });
    if (!['windows', 'mac'].includes(a.os)) errs.push(`${b}.os must be windows or mac`);
    if (!['x64', 'arm64'].includes(a.arch)) errs.push(`${b}.arch must be x64 or arm64`);
    str(a.file, `${b}.file`);
    str(a.url, `${b}.url`, { url: true });
    if (a.url && r.version && a.file && /github\.com/.test(a.url)) {
      const want = `/releases/download/v${r.version}/${a.file}`;
      if (!a.url.endsWith(want)) errs.push(`${b}.url should end with ${want}`);
    }
    str(a.mirror, `${b}.mirror`, { required: false, url: true });
    str(a.size, `${b}.size`, { allowTodo: true });
    str(a.sha256, `${b}.sha256`, { allowTodo: true });
    if (a.sha256 && !/^TODO/i.test(a.sha256) && !/^[0-9a-f]{64}$/i.test(a.sha256)) errs.push(`${b}.sha256 must be 64 hex characters`);
    if (a.bytes !== undefined) {
      if (!Number.isInteger(a.bytes) || a.bytes <= 0) errs.push(`${b}.bytes must be a positive integer (exact file size)`);
      else if (typeof a.size === 'string' && /^[\d.]+ MB$/.test(a.size) && (a.bytes / 1048576).toFixed(1) !== a.size.split(' ')[0])
        errs.push(`${b}.size "${a.size}" does not match bytes ${a.bytes} (${(a.bytes / 1048576).toFixed(1)} MB)`);
    }
  }
  const ids = new Set();
  if (!Array.isArray(cfg.videos)) errs.push('videos must be an array');
  else
    cfg.videos.forEach((v, i) => {
      const b = `videos[${i}]`;
      str(v.id, `${b}.id`);
      if (ids.has(v.id)) errs.push(`${b}.id "${v.id}" is used twice`);
      ids.add(v.id);
      str(v.title, `${b}.title`);
      str(v.desc, `${b}.desc`, { required: false });
      str(v.poster, `${b}.poster`, { url: true });
      str(v.url, `${b}.url`, { required: false, url: true });
      str(v.embed, `${b}.embed`, { required: false, url: true });
      str(v.url_portrait, `${b}.url_portrait`, { required: false, url: true });
      str(v.poster_portrait, `${b}.poster_portrait`, { required: false, url: true });
      if (v.url_portrait && !(v.url && v.url.trim())) errs.push(`${b}.url_portrait needs url (the 16:9 file) as well`);
      if (v.chapters === undefined) return;
      if (!Array.isArray(v.chapters)) return errs.push(`${b}.chapters must be an array`);
      const live = !!((v.url && v.url.trim()) || (v.embed && v.embed.trim()));
      let prev = -1;
      v.chapters.forEach((c, j) => {
        const cp = `${b}.chapters[${j}]`;
        if (!c || typeof c !== 'object') return errs.push(`${cp} must be an object`);
        str(c.title, `${cp}.title`);
        str(c.start, `${cp}.start`, { required: live });
        if (!live && !c.start) return;
        if (typeof c.start !== 'string' || !/^\d+(:\d{2}){1,2}$/.test(c.start)) return errs.push(`${cp}.start must look like 0:00 or 1:02:03`);
        const sec = c.start.split(':').reduce((acc, x) => acc * 60 + Number(x), 0);
        if (j === 0 && sec !== 0) errs.push(`${cp}.start should be 0:00 (first chapter)`);
        if (sec <= prev) errs.push(`${cp}.start must be later than the previous chapter`);
        prev = sec;
      });
    });
  const c = cfg.community || {};
  str(c.qq_group, 'community.qq_group');
  str(c.qq_link, 'community.qq_link', { required: false, url: true });
  str(c.license_contact, 'community.license_contact');
  const pa = cfg.partner;
  if (!pa || typeof pa !== 'object') errs.push('partner is missing');
  else {
    if (typeof pa.enabled !== 'boolean') errs.push('partner.enabled must be true or false');
    if (typeof pa.one_click_import !== 'boolean') errs.push('partner.one_click_import must be true or false');
    for (const k of ['name', 'contact', 'notice']) str(pa[k], `partner.${k}`, { required: false });
    for (const k of ['url', 'register_url', 'token_page_url', 'logo']) str(pa[k], `partner.${k}`, { required: false, url: true });
    if (pa.enabled && !pa.name) errs.push('partner.name is required when partner.enabled is true');
  }
  const todos = [];
  const scan = (o, p) => {
    if (typeof o === 'string' && /^TODO/i.test(o)) todos.push(p);
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) scan(v, p ? `${p}.${k}` : k);
  };
  scan(cfg, '');
  return { errs, todos };
}

function checkConfig() {
  console.log('\n[3] config.json schema');
  let cfg;
  const text = fs.readFileSync(CONFIG, 'utf8');
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    return fail(`config.json is not valid JSON: ${e.message}`);
  }
  const { errs, todos } = validateConfig(cfg);
  errs.forEach(fail);
  if (!errs.length) ok('config.json matches the schema');
  if (todos.length) console.log(`  todo  ${todos.length} TODO values to fill at release: ${todos.join(', ')}`);
  const fb = fs.existsSync(FALLBACK) ? fs.readFileSync(FALLBACK, 'utf8') : '';
  if (fb !== fallbackSource(text)) fail('assets/js/config-fallback.js is out of date: run node scripts/check-site.mjs --sync');
  else ok('config-fallback.js matches config.json');
  return cfg;
}

/* ---------- 4. live download links ---------- */
// Follows redirects (GitHub release links answer 302 to a CDN) and compares the final size with bytes.
// curl is preferred when present because it honours the proxy setups Node's fetch ignores.
function probeCurl(url) {
  return new Promise((resolve) => {
    execFile('curl', ['-sIL', '--max-time', '40', url], { windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const blocks = stdout.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//.test(b.trim()));
      const last = blocks[blocks.length - 1] || '';
      const status = Number((last.match(/^HTTP\/[\d.]+ (\d+)/) || [])[1] || 0);
      const length = Number((last.match(/^content-length:\s*(\d+)/im) || [])[1] || 0);
      resolve(status ? { status, length } : { status: 0, error: (err && err.message) || 'no response' });
    });
  });
}

async function probe(url) {
  const viaCurl = await probeCurl(url);
  if (viaCurl) return viaCurl;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
    // Some mirrors reject HEAD; a one-byte range request is the cheapest fallback.
    if (res.status === 405 || res.status === 403) {
      res = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal: ctl.signal });
      const total = Number((res.headers.get('content-range') || '').split('/')[1]);
      res.body?.cancel().catch(() => {});
      return { status: res.status === 206 ? 200 : res.status, length: total || Number(res.headers.get('content-length')) };
    }
    return { status: res.status, length: Number(res.headers.get('content-length')) };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function checkLive(cfg) {
  console.log('\n[4] Download links are live (HEAD, following redirects)');
  const assets = (cfg.release && cfg.release.assets) || {};
  const jobs = [];
  for (const [id, a] of Object.entries(assets)) {
    for (const [kind, url] of [['url', a.url], ['mirror', a.mirror]]) {
      if (!url || /^TODO/i.test(url) || !/^https?:/i.test(url)) continue;
      jobs.push((async () => {
        let r = await probe(url);
        if (!r.status) r = await probe(url);
        const name = `${id}.${kind}`;
        if (r.status !== 200) return fail(`${name}: ${url} -> ${r.status || r.error}`);
        if (Number.isInteger(a.bytes) && r.length && r.length !== a.bytes) return fail(`${name}: size ${r.length} != bytes ${a.bytes}`);
        ok(`${name}: 200${r.length ? `, ${r.length} bytes` : ''}${Number.isInteger(a.bytes) && r.length === a.bytes ? ' (matches)' : ''}`);
      })());
    }
  }
  await Promise.all(jobs);
}

/* ---------- 5. headless browser ---------- */
function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = [process.env.PLAYWRIGHT_CORE, 'playwright-core', 'C:/Users/Administrator/Documents/Codex/omni-creator/node_modules/playwright-core'].filter(Boolean);
  for (const t of tries) {
    try {
      return req(t);
    } catch {}
  }
  return null;
}
function findBrowser() {
  const c = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return c.find((p) => fs.existsSync(p));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
function serve(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(dir, p);
      if (!f.startsWith(dir) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// Lazy images only load when scrolled into view, so walk the page and wait for every image.
async function loadAllImages(page) {
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    for (let y = 0; y < document.body.scrollHeight; y += Math.max(300, window.innerHeight / 2)) {
      window.scrollTo(0, y);
      await sleep(60);
    }
    await Promise.all([...document.images].filter((i) => !i.hidden && i.getAttribute('src')).map((i) => (i.complete ? null : new Promise((res) => { i.onload = i.onerror = res; }))));
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function checkBrowser(cfg) {
  console.log('\n[5] Headless browser (console errors, failed requests, layout, screenshots)');
  const pw = loadPlaywright();
  const exe = findBrowser();
  if (!pw || !exe) return fail('playwright-core or Chrome/Edge not found (set PLAYWRIGHT_CORE / CHROME_PATH, or use --static)');
  const shots = path.resolve(opt('--shots', path.join(ROOT, 'dist', 'shots')));
  fs.mkdirSync(shots, { recursive: true });
  const srv = await serve(SITE);
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await pw.chromium.launch({ executablePath: exe });
  const partnerCfg = JSON.parse(JSON.stringify(cfg));
  Object.assign(partnerCfg.partner, {
    enabled: true,
    name: '示例 API 站',
    url: 'https://example.com/',
    register_url: 'https://example.com/register',
    token_page_url: 'https://example.com/console/token',
    contact: 'QQ 群 10000000',
    one_click_import: true,
    notice: '新用户注册即送体验额度（示例公告，由合作站点在 config.json 中填写）。',
  });
  const runs = [
    { name: 'desktop-light', url: base, viewport: { width: 1440, height: 900 }, scheme: 'light', ua: 'win' },
    { name: 'desktop-dark', url: base, viewport: { width: 1440, height: 900 }, scheme: 'dark', ua: 'mac' },
    { name: 'mobile-light', url: base, viewport: { width: 390, height: 844 }, scheme: 'light', mobile: true },
    { name: 'mobile-dark', url: base, viewport: { width: 390, height: 844 }, scheme: 'dark', mobile: true },
    { name: 'tablet-light', url: base, viewport: { width: 820, height: 1180 }, scheme: 'light', ua: 'win' },
    { name: 'file-protocol', url: pathToFileURL(path.join(SITE, 'index.html')).href, viewport: { width: 1280, height: 800 }, scheme: 'light', ua: 'win' },
    { name: 'partner-demo', url: base, viewport: { width: 1440, height: 900 }, scheme: 'light', ua: 'win', partner: true },
  ];
  const UAS = {
    win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    mobile: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  };
  for (const r of runs) {
    const ctx = await browser.newContext({
      viewport: r.viewport,
      deviceScaleFactor: r.mobile ? 2 : 1,
      isMobile: !!r.mobile,
      hasTouch: !!r.mobile,
      colorScheme: r.scheme,
      userAgent: UAS[r.mobile ? 'mobile' : r.ua],
    });
    if (r.ua === 'mac') {
      // A custom user agent does not change navigator.platform, so emulate a Mac explicitly.
      await ctx.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
        Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 0 });
      });
    }
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (q) => errors.push(`requestfailed: ${q.url()} ${q.failure()?.errorText}`));
    page.on('response', (s) => s.status() >= 400 && errors.push(`http ${s.status()}: ${s.url()}`));
    if (r.partner) await page.route('**/config.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(partnerCfg) }));
    await page.goto(r.url, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#dl-grid .dl-card').length >= 4, null, { timeout: 5000 }).catch(() => errors.push('download cards did not render'));
    await loadAllImages(page);
    const info = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      broken: [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && !i.hidden && i.getAttribute('src')).map((i) => i.getAttribute('src')),
      hero: document.querySelector('#hero-dl-label')?.textContent,
      detected: document.querySelector('.dl-card.detected h3')?.textContent || '',
      partnerBar: !document.querySelector('#partner-bar').hidden,
      platform: document.documentElement.getAttribute('data-platform'),
      height: document.body.scrollHeight,
    }));
    if (info.overflow > 1) errors.push(`horizontal overflow ${info.overflow}px`);
    if (info.broken.length) errors.push(`broken images: ${info.broken.join(', ')}`);
    const wantBar = r.partner || Boolean(cfg.partner?.enabled);
    if (wantBar && !info.partnerBar) errors.push('partner bar not shown while partner.enabled is true');
    if (!wantBar && info.partnerBar) errors.push('partner bar shown while partner.enabled is false');
    // Interactive smoke: copy a prompt, open a FAQ, switch uninstall tab.
    await page.locator('#ut-mac').click();
    if (!(await page.locator('#up-mac').isVisible())) errors.push('uninstall tab did not switch');
    if (r.mobile) {
      await page.locator('#menu-btn').click();
      if (!(await page.locator('#nav').isVisible())) errors.push('mobile menu did not open');
      await page.locator('#menu-btn').click();
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(shots, `${r.name}-fold.png`) });
    if (r.name !== 'file-protocol') {
      const ctxFull = r.mobile ? await browser.newContext({ viewport: r.viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: r.scheme, userAgent: UAS.mobile }) : null;
      let fullPage = page;
      if (ctxFull) {
        fullPage = await ctxFull.newPage();
        if (r.partner) await fullPage.route('**/config.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(partnerCfg) }));
        await fullPage.goto(r.url, { waitUntil: 'load' });
        await loadAllImages(fullPage);
      }
      // A sticky header is painted mid-page in full-page captures; pin it to the top instead.
      await fullPage.addStyleTag({ content: '.topbar{position:relative!important}' });
      await fullPage.screenshot({ path: path.join(shots, `${r.name}-full.png`), fullPage: true });
      if (ctxFull) await ctxFull.close();
    }
    const expect = r.mobile ? 'mobile' : r.ua === 'mac' ? 'mac-' : 'win';
    if (!String(info.platform).startsWith(expect)) errors.push(`platform detected as ${info.platform}, expected ${expect}`);
    const label = `${r.name} (${r.viewport.width}x${r.viewport.height}, platform=${info.platform}, hero="${info.hero}", detected="${info.detected}", height=${info.height})`;
    if (errors.length) errors.forEach((e) => fail(`${r.name}: ${e}`));
    else ok(label);
    await ctx.close();
  }
  await checkVideos(browser, base, cfg);
  await browser.close();
  srv.close();
  console.log(`  shots ${shots}`);
}

// Simulates a published chaptered video (no real video needs to exist yet): the player opens
// on click, chapter buttons seek, and the current chapter is highlighted. --test-video FILE
// supplies a short clip (any format Chrome plays); without it only the embed path is tested.
async function checkVideos(browser, base, cfg) {
  const withChapters = (cfg.videos || []).find((v) => Array.isArray(v.chapters) && v.chapters.length >= 3);
  if (!withChapters) return ok('video chapters: no chaptered video configured, skipped');
  const n = withChapters.chapters.length;
  const timed = (extra) => {
    const c = JSON.parse(JSON.stringify(cfg));
    const v = c.videos.find((x) => x.id === withChapters.id);
    v.chapters.forEach((ch, i) => (ch.start = `0:${String(i * 2).padStart(2, '0')}`));
    Object.assign(v, extra);
    return c;
  };
  const run = async (label, conf, routes, fn) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.route('**/config.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(conf) }));
    for (const [pat, handler] of routes) await page.route(pat, handler);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#dl-grid .dl-card').length >= 4, null, { timeout: 5000 }).catch(() => {});
    const card = page.locator(`[data-video="${withChapters.id}"]`);
    try {
      await fn(page, card, errors);
    } catch (e) {
      errors.push(e.message.split('\n')[0]);
    }
    if (errors.length) errors.forEach((e) => fail(`video ${label}: ${e}`));
    else ok(`video ${label}`);
    await ctx.close();
  };

  const pending = JSON.parse(JSON.stringify(cfg));
  const pv = pending.videos.find((x) => x.id === withChapters.id);
  for (const k of ['url', 'url_portrait', 'embed']) pv[k] = '';
  await run('pending (no url): chapters listed, no player opens', pending, [], async (page, card, errors) => {
    if (await card.evaluate((c) => c.classList.contains('ready'))) errors.push('card marked ready without a url');
    const count = await card.locator('.ch-list button').count();
    if (count !== n) errors.push(`expected ${n} chapter buttons, got ${count}`);
    await card.locator('.ch-list button').nth(1).click();
    if (await page.locator('#video-dialog').evaluate((d) => d.open)) errors.push('dialog opened for a pending video');
    if (!/制作中/.test(await page.locator('#toast').textContent())) errors.push('no "coming soon" toast');
  });

  await run('embed: chapter click reloads the iframe at the chapter start', timed({ embed: '__test__/embed.html' }), [
    ['**/__test__/embed.html*', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>e</title>' })],
  ], async (page, card, errors) => {
    await card.locator('.ch-list button').nth(2).click();
    await page.waitForSelector('#vd-stage iframe');
    const src = await page.locator('#vd-stage iframe').getAttribute('src');
    if (!/[?&]t=4(&|$)/.test(src)) errors.push(`iframe src missing t=4: ${src}`);
    await page.locator('#vd-chapters button').nth(3).click();
    const src2 = await page.locator('#vd-stage iframe').getAttribute('src');
    if (!/[?&]t=6(&|$)/.test(src2) || /t=4/.test(src2)) errors.push(`iframe not re-pointed to t=6: ${src2}`);
    const on = await page.locator('#vd-chapters button.on').count();
    if (on !== 1) errors.push(`expected one highlighted chapter, got ${on}`);
    await page.locator('#vd-close').click();
    if (await page.locator('#vd-stage iframe').count()) errors.push('iframe not removed on close');
  });

  const clip = opt('--test-video', '');
  if (!clip || !fs.existsSync(clip)) return ok('video file playback: skipped (pass --test-video FILE to test seeking)');
  const ext = path.extname(clip).toLowerCase();
  const type = ext === '.webm' ? 'video/webm' : 'video/mp4';
  const body = fs.readFileSync(clip);
  await run('file: player opens at chapter, seeking and highlight follow', timed({ url: `__test__/clip${ext}` }), [
    // Media elements can only seek when the server honours Range requests.
    [`**/__test__/clip${ext}`, (r) => {
      const m = /bytes=(\d+)-(\d*)/.exec(r.request().headers()['range'] || '');
      if (!m) return r.fulfill({ status: 200, contentType: type, headers: { 'accept-ranges': 'bytes' }, body });
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
      return r.fulfill({ status: 206, contentType: type, headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}` }, body: body.subarray(start, end + 1) });
    }],
  ], async (page, card, errors) => {
    if (!(await card.evaluate((c) => c.classList.contains('ready')))) errors.push('card not marked ready');
    await card.locator('.ch-list button').nth(2).click();
    await page.waitForSelector('#vd-stage video');
    await page.waitForFunction(() => { const v = document.querySelector('#vd-stage video'); return v && v.readyState >= 1 && v.currentTime >= 3.9; }, null, { timeout: 2500 })
      .catch(() => errors.push('video did not start at chapter 3 (4s)'));
    await page.locator('#vd-chapters button').nth(1).click();
    const t = await page.locator('#vd-stage video').evaluate((v) => v.currentTime);
    if (Math.abs(t - 2) > 0.6) errors.push(`seek to chapter 2 landed at ${t.toFixed(2)}s`);
    await page.waitForTimeout(200);
    const idx = await page.locator('#vd-chapters button').evaluateAll((bs) => bs.findIndex((b) => b.classList.contains('on')));
    if (idx !== 1) errors.push(`highlighted chapter index ${idx}, expected 1`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    if (await page.locator('#vd-stage video').count()) errors.push('video not removed when the dialog closed');
  });
}

checkForbidden();
checkLinks();
const cfg = checkConfig();
if (cfg && (flag('--live') || (!flag('--static') && !flag('--offline')))) await checkLive(cfg);
if (cfg && !flag('--static')) await checkBrowser(cfg);
console.log(failures ? `\n${failures} problem(s) found.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
