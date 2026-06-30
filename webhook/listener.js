const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = process.env.WEBHOOK_PORT || 9000;
const SECRET = process.env.WEBHOOK_SECRET || '';
const REPO_PATH = process.env.REPO_PATH || '/opt/stacks/jarvis';

function verifySignature(payload, signature) {
  if (!SECRET) return true;
  const hmac = crypto.createHmac('sha256', SECRET);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature || ''));
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/deploy') {
    res.statusCode = 404;
    return res.end('not found');
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const signature = req.headers['x-hub-signature-256'];
    if (!verifySignature(body, signature)) {
      res.statusCode = 401;
      return res.end('invalid signature');
    }

    res.statusCode = 200;
    res.end('deploying');

    console.log('Webhook received, pulling and rebuilding...');
    exec(`cd ${REPO_PATH} && git pull && docker compose up -d --build`, (err, stdout, stderr) => {
      if (err) {
        console.error('Deploy failed:', err.message);
        return;
      }
      console.log('Deploy output:', stdout);
      if (stderr) console.error('Deploy stderr:', stderr);
    });
  });
});

server.listen(PORT, () => console.log(`Webhook listener running on :${PORT}`));
