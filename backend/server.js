const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const ADGUARD_URL = process.env.ADGUARD_URL || 'http://localhost:3000';
const ADGUARD_USER = process.env.ADGUARD_USER || 'tymastrangelo';
const ADGUARD_PASS = process.env.ADGUARD_PASS || '';
const KUMA_URL = process.env.KUMA_URL || 'http://localhost:3001';
const KUMA_API_KEY = process.env.KUMA_API_KEY || '';
const NETALERTX_URL = process.env.NETALERTX_URL || 'http://localhost:20211';
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'tymastrangelo';
const WEATHER_LAT = process.env.WEATHER_LAT || '25.9408';
const WEATHER_LON = process.env.WEATHER_LON || '-81.7187';
const PORT = process.env.PORT || 4000;

// ---- Auth + live-update config ----
// If DASHBOARD_PASSWORD is empty, auth is DISABLED and the dashboard stays
// open. This is deliberate: it guarantees you can never lock yourself out by
// deploying before configuring a password. Set it in .env to turn auth on.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const AUTH_ENABLED = DASHBOARD_PASSWORD.length > 0;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_MS = parseInt(process.env.REFRESH_MS || '3000', 10); // live push cadence
const DATA_DIR = '/app/data-persist';

// Session-signing secret. Persisted so logins survive backend restarts.
// Falls back to in-memory if the volume isn't writable (logins reset on restart).
function loadOrCreateSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = DATA_DIR + '/.session-secret';
  try { return fs.readFileSync(file, 'utf8').trim(); } catch {}
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch {}
  return secret;
}
const SESSION_SECRET = loadOrCreateSecret();

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signPayload(payload) {
  return b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
}
function makeToken() {
  const payload = b64url(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS }));
  return payload + '.' + signPayload(payload);
}
function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return false;
  const [payload, sig] = token.split('.');
  const expected = signPayload(payload);
  if (!sig || sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    return data.exp > Date.now();
  } catch { return false; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) {
  if (!AUTH_ENABLED) return true;
  return verifyToken(parseCookies(req).jarvis_session);
}
function safeStrEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function run(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
}

let lastCpuSample = null;
async function getCpuUsage() {
  const raw = await run("cat /proc/stat | grep '^cpu '");
  if (!raw) return 0;
  const parts = raw.split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] || 0);
  const total = parts.reduce((a, b) => a + b, 0);
  if (!lastCpuSample) {
    lastCpuSample = { idle, total };
    return 0;
  }
  const idleDelta = idle - lastCpuSample.idle;
  const totalDelta = total - lastCpuSample.total;
  lastCpuSample = { idle, total };
  if (totalDelta <= 0) return 0;
  return Math.round((1 - idleDelta / totalDelta) * 100);
}

function fetchAdguard(path) {
  return new Promise((resolve) => {
    const auth = Buffer.from(`${ADGUARD_USER}:${ADGUARD_PASS}`).toString('base64');
    const url = new URL(path, ADGUARD_URL);
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    const req = mod.get(url.toString(), {
      headers: { 'Authorization': `Basic ${auth}` }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

function fetchJson(fullUrl, headers) {
  return new Promise((resolve) => {
    const mod = fullUrl.startsWith('https:') ? require('https') : require('http');
    const req = mod.get(fullUrl, { headers: headers || {} }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

async function getUptimeKumaStatus() {
  if (!KUMA_API_KEY) return { available: false, reason: 'no api key configured' };
  const auth = Buffer.from(`${KUMA_API_KEY}:`).toString('base64');
  const metricsText = await new Promise((resolve) => {
    const req = require('http').get(`${KUMA_URL}/metrics`, {
      headers: { 'Authorization': `Basic ${auth}` }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(res.statusCode === 200 ? data : null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
  if (!metricsText) return { available: false, reason: 'fetch failed' };

  const lines = metricsText.split('\n').filter(l => l.startsWith('monitor_status'));
  const monitors = lines.map(line => {
    const nameMatch = line.match(/monitor_name="([^"]+)"/);
    const valueMatch = line.match(/\}\s+(\d+)/);
    return {
      id: nameMatch ? nameMatch[1] : 'unknown',
      up: valueMatch ? valueMatch[1] === '1' : false,
    };
  });
  const up = monitors.filter(m => m.up).length;
  const down = monitors.length - up;
  return { up, down, total: monitors.length, monitors, available: true };
}

async function getNetAlertXDevices() {
  const raw = await run(`sqlite3 /netalertx-db/app.db "SELECT COUNT(*), SUM(CASE WHEN devPresentLastScan=1 THEN 1 ELSE 0 END) FROM Devices;" 2>&1`);
  const parts = raw.split('|').map(s => s.trim());
  const total = parseInt(parts[0]);
  if (isNaN(total)) return { available: false, count: null, error: raw.slice(0, 150) };
  const online = parseInt(parts[1]);
  return { available: true, count: total, online: isNaN(online) ? null : online };
}

async function getGithubActivity() {
  const data = await fetchJson('https://api.github.com/users/tymastrangelo/events/public', {
    'User-Agent': 'jarvis-dashboard',
  });
  if (!Array.isArray(data)) return { available: false, events: [] };

  const events = data.slice(0, 8).map(e => {
    let summary = '';
    const repo = e.repo ? e.repo.name.split('/')[1] : 'unknown';
    switch (e.type) {
      case 'PushEvent':
        const commitCount = e.payload && e.payload.commits ? e.payload.commits.length : 0;
        summary = `pushed ${commitCount} commit${commitCount !== 1 ? 's' : ''}`;
        break;
      case 'CreateEvent':
        summary = `created ${e.payload ? e.payload.ref_type : 'repo'}`;
        break;
      case 'PullRequestEvent':
        summary = `${e.payload ? e.payload.action : 'updated'} PR`;
        break;
      case 'IssuesEvent':
        summary = `${e.payload ? e.payload.action : 'updated'} issue`;
        break;
      case 'WatchEvent':
        summary = 'starred';
        break;
      case 'ForkEvent':
        summary = 'forked';
        break;
      case 'DeleteEvent':
        summary = `deleted ${e.payload ? e.payload.ref_type : 'branch'}`;
        break;
      default:
        summary = e.type.replace('Event', '').toLowerCase();
    }
    return { repo, summary, created_at: e.created_at };
  });
  return { available: true, events };
}

async function getSystemStats() {
  const [
    cpuUsage, memRaw, uptimeRaw, tempRaw,
    diskRaw, loadRaw, processesRaw,
    networkRaw, hostnameRaw,
    osRaw, kernelRaw, swapRaw, cloudflaredStatus
  ] = await Promise.all([
    getCpuUsage(),
    run("free -b | awk 'NR==2{print $2,$3,$4}'"),
    run("cat /proc/uptime | awk '{print $1}'"),
    run("cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo '0'"),
    run("df -B1 / | awk 'NR==2{print $2,$3,$4,$5}'"),
    run("cat /proc/loadavg"),
    run("ps aux | wc -l"),
    run("cat /proc/net/dev | grep -E 'enp|eth' | head -1 | awk '{print $2,$10}'"),
    run("hostname"),
    run("cat /host/etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'\"' -f2 || echo 'Ubuntu 24.04'"),
    run("uname -r"),
    run("free -b | awk 'NR==3{print $2,$3,$4}'"),
    run("pgrep -f cloudflared > /dev/null && echo running || echo stopped"),
  ]);

  const dockerContainers = await getDockerViaSocket();

  const [memTotal, memUsed, memFree] = memRaw.split(' ').map(Number);
  const [swapTotal, swapUsed] = swapRaw.split(' ').map(Number);
  const [diskTotal, diskUsed, diskFree] = diskRaw.split(' ').map(Number);
  const [netRx, netTx] = networkRaw.split(' ').map(Number);
  const tempC = Math.round(parseInt(tempRaw) / 1000);
  const uptimeSecs = parseFloat(uptimeRaw);
  const days = Math.floor(uptimeSecs / 86400);
  const hours = Math.floor((uptimeSecs % 86400) / 3600);
  const mins = Math.floor((uptimeSecs % 3600) / 60);
  const [load1, load5, load15] = loadRaw.split(' ').slice(0, 3).map(parseFloat);

  return {
    hostname: hostnameRaw || 'macmini',
    os: osRaw || 'Ubuntu 24.04',
    kernel: kernelRaw,
    cpu: {
      usage: cpuUsage || 0,
      load1: load1 || 0,
      load5: load5 || 0,
      load15: load15 || 0,
    },
    memory: {
      total: memTotal || 0,
      used: memUsed || 0,
      free: memFree || 0,
      pct: memTotal ? Math.round((memUsed / memTotal) * 100) : 0,
    },
    swap: {
      total: swapTotal || 0,
      used: swapUsed || 0,
      pct: swapTotal ? Math.round((swapUsed / swapTotal) * 100) : 0,
    },
    temperature: isNaN(tempC) || tempC === 0 ? null : tempC,
    uptime: { days, hours, mins, seconds: Math.floor(uptimeSecs) },
    disk: {
      total: diskTotal || 0,
      used: diskUsed || 0,
      free: diskFree || 0,
      pct: diskTotal ? Math.round((diskUsed / diskTotal) * 100) : 0,
    },
    network: { rx_bytes: netRx || 0, tx_bytes: netTx || 0 },
    processes: parseInt(processesRaw) - 1 || 0,
    docker: dockerContainers,
    cloudflared_running: cloudflaredStatus === 'running',
  };
}

function dockerSocketRequest(path) {
  return new Promise((resolve) => {
    const http2 = require('http');
    const req = http2.request({
      socketPath: '/var/run/docker.sock',
      path,
      method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function getDockerViaSocket() {
  const containers = await dockerSocketRequest('/containers/json?all=true');
  if (!Array.isArray(containers)) return [];
  return containers.map(c => ({
    name: (c.Names && c.Names[0] || '').replace(/^\//, ''),
    status: c.Status,
    image: c.Image,
    up: c.State === 'running',
  }));
}

async function getDockerStatsViaSocket() {
  const containers = await dockerSocketRequest('/containers/json');
  if (!Array.isArray(containers)) return [];
  const statsPromises = containers.map(async (c) => {
    const stats = await dockerSocketRequest(`/containers/${c.Id}/stats?stream=false`);
    if (!stats) return null;
    const name = (c.Names && c.Names[0] || '').replace(/^\//, '');
    let cpuPct = 0;
    try {
      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      const numCpus = stats.cpu_stats.online_cpus || 1;
      if (sysDelta > 0) cpuPct = ((cpuDelta / sysDelta) * numCpus * 100);
    } catch {}
    const memUsage = stats.memory_stats && stats.memory_stats.usage || 0;
    const memLimit = stats.memory_stats && stats.memory_stats.limit || 1;
    let netRx = 0, netTx = 0;
    if (stats.networks) {
      Object.values(stats.networks).forEach(n => { netRx += n.rx_bytes || 0; netTx += n.tx_bytes || 0; });
    }
    return {
      name,
      cpu: cpuPct.toFixed(1) + '%',
      mem: formatBytesShort(memUsage) + ' / ' + formatBytesShort(memLimit),
      net: formatBytesShort(netRx) + ' / ' + formatBytesShort(netTx),
      block: '--',
    };
  });
  const results = await Promise.all(statsPromises);
  return results.filter(Boolean);
}

function formatBytesShort(b) {
  if (b > 1e9) return (b / 1e9).toFixed(2) + 'GB';
  if (b > 1e6) return (b / 1e6).toFixed(1) + 'MB';
  if (b > 1e3) return (b / 1e3).toFixed(1) + 'KB';
  return b + 'B';
}

async function getAdguardStats() {
  const [stats, status] = await Promise.all([
    fetchAdguard('/control/stats'),
    fetchAdguard('/control/status'),
  ]);
  if (!stats) return null;
  return {
    queries: stats.num_dns_queries || 0,
    blocked: stats.num_blocked_filtering || 0,
    blocked_pct: stats.num_dns_queries
      ? Math.round((stats.num_blocked_filtering / stats.num_dns_queries) * 100)
      : 0,
    blocked_malware: stats.num_replaced_safebrowsing || 0,
    blocked_adult: stats.num_replaced_parental || 0,
    safe_search_enforced: stats.num_replaced_safesearch || 0,
    avg_latency_ms: stats.avg_processing_time ? Math.round(stats.avg_processing_time * 1000) : 0,
    top_blocked: (stats.top_blocked_domains || []).slice(0, 5),
    top_clients: (stats.top_clients || []).slice(0, 5),
    top_queried: (stats.top_queried_domains || []).slice(0, 5),
    running: status ? status.running : false,
    version: status ? status.version : null,
  };
}

async function getTailscaleStatus() {
  const raw = await run('tailscale status --json 2>/dev/null');
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const peers = Object.values(data.Peer || {}).map(p => ({
      hostname: p.HostName,
      ip: p.TailscaleIPs ? p.TailscaleIPs[0] : null,
      online: p.Online,
      os: p.OS,
      last_seen: p.LastSeen,
    }));
    const self = data.Self ? {
      hostname: data.Self.HostName,
      ip: data.Self.TailscaleIPs ? data.Self.TailscaleIPs[0] : null,
      online: true,
      os: data.Self.OS,
    } : null;
    return { self, peers, backend_state: data.BackendState };
  } catch { return null; }
}

async function getDockerDetails() {
  return getDockerStatsViaSocket();
}

async function computeStats() {
  const [system, adguard, tailscale, dockerDetails, uptimeKuma, netalertx, github] = await Promise.all([
    getSystemStats(),
    getAdguardStats(),
    getTailscaleStatus(),
    getDockerDetails(),
    getUptimeKumaStatus(),
    getNetAlertXDevices(),
    getGithubActivity(),
  ]);
  return {
    timestamp: new Date().toISOString(),
    system,
    adguard,
    tailscale,
    docker_details: dockerDetails,
    uptime_kuma: uptimeKuma,
    netalertx,
    github,
  };
}

const path = require('path');
const LAYOUT_FILE = '/app/data-persist/layout.json';

function loadLayout() {
  try {
    return JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveLayout(layout) {
  try {
    fs.mkdirSync('/app/data-persist', { recursive: true });
    fs.writeFileSync(LAYOUT_FILE, JSON.stringify(layout));
    return true;
  } catch {
    return false;
  }
}

// ---- Live stats cache + Server-Sent Events fan-out ----
// One compute loop refreshes the cache every REFRESH_MS and pushes to every
// connected client, instead of each browser triggering its own expensive
// gather. Sampling on a fixed cadence also makes the CPU delta consistent.
let latestStats = null;
let lastError = null;
const sseClients = new Set();

function broadcast(stats) {
  const frame = `data: ${JSON.stringify(stats)}\n\n`;
  for (const res of sseClients) { try { res.write(frame); } catch {} }
}

async function refreshLoop() {
  try {
    latestStats = await computeStats();
    lastError = null;
    broadcast(latestStats);
  } catch (e) {
    lastError = e.message;
  } finally {
    setTimeout(refreshLoop, REFRESH_MS);
  }
}

// Heartbeat keeps the SSE connection alive through proxy/tunnel idle timeouts.
setInterval(() => {
  for (const res of sseClients) { try { res.write(': ping\n\n'); } catch {} }
}, 15000);

function sendJson(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  // ----- Auth endpoints (always open) -----
  if (req.url === '/api/me') {
    return sendJson(res, 200, { authed: isAuthed(req), authRequired: AUTH_ENABLED });
  }

  if (req.url === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    let password = '';
    try { password = (JSON.parse(body || '{}').password) || ''; } catch {}
    if (!AUTH_ENABLED) return sendJson(res, 200, { ok: true, authRequired: false });
    if (safeStrEqual(password, DASHBOARD_PASSWORD)) {
      const token = makeToken();
      res.setHeader('Set-Cookie',
        `jarvis_session=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 401, { ok: false, error: 'invalid credentials' });
  }

  if (req.url === '/api/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', 'jarvis_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    return sendJson(res, 200, { ok: true });
  }

  if (req.url === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  // ----- Everything below requires auth (when enabled) -----
  if (!isAuthed(req)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  // Live event stream
  if (req.url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 5000\n\n');
    if (latestStats) res.write(`data: ${JSON.stringify(latestStats)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.url === '/api/stats') {
    try {
      const stats = latestStats || await computeStats();
      return sendJson(res, 200, stats);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (req.url === '/api/layout' && req.method === 'GET') {
    return sendJson(res, 200, loadLayout() || {});
  }

  if (req.url === '/api/layout' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const ok = saveLayout(JSON.parse(body));
      return sendJson(res, 200, { ok });
    } catch (e) {
      return sendJson(res, 400, { error: 'invalid json' });
    }
  }

  return sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`JARVIS backend running on :${PORT} (auth ${AUTH_ENABLED ? 'ENABLED' : 'disabled'})`);
  refreshLoop();
});
