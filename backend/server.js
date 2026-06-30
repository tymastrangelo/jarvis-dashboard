const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');

const ADGUARD_URL = process.env.ADGUARD_URL || 'http://localhost:3000';
const ADGUARD_USER = process.env.ADGUARD_USER || 'tymastrangelo';
const ADGUARD_PASS = process.env.ADGUARD_PASS || '';
const KUMA_URL = process.env.KUMA_URL || 'http://localhost:3001';
const KUMA_API_KEY = process.env.KUMA_API_KEY || '';
const NETALERTX_URL = process.env.NETALERTX_URL || 'http://localhost:20211';
const PORT = process.env.PORT || 4000;

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

async function getStats() {
  const [system, adguard, tailscale, dockerDetails, uptimeKuma, netalertx] = await Promise.all([
    getSystemStats(),
    getAdguardStats(),
    getTailscaleStatus(),
    getDockerDetails(),
    getUptimeKumaStatus(),
    getNetAlertXDevices(),
  ]);
  return {
    timestamp: new Date().toISOString(),
    system,
    adguard,
    tailscale,
    docker_details: dockerDetails,
    uptime_kuma: uptimeKuma,
    netalertx,
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/stats') {
    try {
      const stats = await getStats();
      res.end(JSON.stringify(stats));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/health') {
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PORT, () => console.log(`JARVIS backend running on :${PORT}`));
