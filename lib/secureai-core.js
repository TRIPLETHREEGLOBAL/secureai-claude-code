'use strict';
/**
 * Minimal SecureAI Core client for adapters (Node >= 18, no dependencies).
 *
 * - Finds the per-install secret (never a built-in default)
 * - Speaks the Core IPC protocol (newline JSON over named pipe / Unix socket)
 *   with the HMAC Hello handshake
 * - Adapters only *ask* Core; they never decide or report Protected themselves
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const PROTOCOL_MAJOR = 1;
const PROTOCOL_MINOR = 1;
const TIMEOUT_MS = 4000;
const CUSTOMER_PLATFORMS = ['cursor', 'codex', 'claude', 'grok'];

function readSecretFile(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(/^SECUREAI_SECRET=(.*)$/);
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, '');
      if (v) return v;
    }
  }
  const t = raw.trim();
  return t && !t.includes('\n') ? t : null;
}

function secretCandidates() {
  const out = [];
  if (process.env.SECUREAI_SECRET_FILE) out.push(process.env.SECUREAI_SECRET_FILE);
  const roots = [process.env.SECUREAI_INSTALL_ROOT, process.env.SECUREAI_HOME].filter(Boolean);
  for (const r of roots) out.push(path.join(r, 'config', 'ipc.secret'));
  if (process.platform === 'win32' && process.env.ProgramFiles) {
    out.push(path.join(process.env.ProgramFiles, 'SecureAI', 'config', 'ipc.secret'));
  }
  if (process.platform === 'darwin') {
    const base = path.join(os.homedir(), 'Library', 'Application Support', 'SecureAI', 'config');
    out.push(path.join(base, 'ipc.secret'), path.join(base, 'secureai.env'));
  }
  return out;
}

/** Resolve the install secret, or null if SecureAI isn't installed. */
function findSecret() {
  if (process.env.SECUREAI_SECRET && process.env.SECUREAI_SECRET.trim()) {
    return process.env.SECUREAI_SECRET.trim();
  }
  for (const p of secretCandidates()) {
    const v = readSecretFile(p);
    if (v) return v;
  }
  return null;
}

function ipcPath() {
  if (process.env.SECUREAI_IPC_PATH) return process.env.SECUREAI_IPC_PATH;
  if (process.platform === 'win32') return '\\\\.\\pipe\\secureai';
  if (process.platform === 'darwin') {
    // Per-user socket (must match Core's default); Unix socket paths max 104 bytes.
    const p = path.join(os.homedir(), 'Library', 'Application Support', 'SecureAI', 'run', 'secureai.sock');
    return p.length < 100 ? p : `/tmp/secureai-${os.userInfo().username}.sock`;
  }
  if (process.env.XDG_RUNTIME_DIR) return path.join(process.env.XDG_RUNTIME_DIR, 'secureai.sock');
  return '/tmp/secureai.sock';
}

/** RFC 3339 exactly as chrono's `to_rfc3339()` re-renders it (MAC must match). */
function chronoTimestamp(d = new Date()) {
  const iso = d.toISOString(); // 2026-09-23T01:02:03.123Z
  const [base, frac] = iso.slice(0, -1).split('.');
  const ms = frac && frac !== '000' ? `.${frac}` : '';
  return `${base}${ms}+00:00`;
}

class CoreClient {
  constructor({ platform, clientId, secret, socketPath } = {}) {
    this.platform = platform;
    this.clientId = clientId || `${platform}-adapter`;
    this.secret = secret || findSecret();
    this.socketPath = socketPath || ipcPath();
    this.sock = null;
    this.buf = '';
    this.waiters = [];
    this.token = null;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.socketPath);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error('core_unreachable'));
      }, TIMEOUT_MS);
      s.once('connect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', () => {
        clearTimeout(timer);
        reject(new Error('core_unreachable'));
      });
    });
  }

  _request(msg) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('core_timeout')), TIMEOUT_MS * 3);
      this.waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.sock.write(JSON.stringify(msg) + '\n');
    });
  }

  async open() {
    if (!this.secret) throw new Error('not_installed');
    this.sock = await this._connect();
    this.sock.setEncoding('utf8');
    this.sock.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (!w) continue;
        try {
          w(JSON.parse(line));
        } catch (_) {
          w({ kind: 'error', code: 'malformed', message: 'bad frame' });
        }
      }
    });
    this.sock.on('error', () => {});
    const timestamp = chronoTimestamp();
    const canonical = `${PROTOCOL_MAJOR}|${PROTOCOL_MINOR}|${this.platform}|${this.clientId}|${timestamp}`;
    const mac = crypto.createHmac('sha256', this.secret).update(canonical).digest('hex');
    const ack = await this._request({
      kind: 'hello',
      protocol_major: PROTOCOL_MAJOR,
      protocol_minor: PROTOCOL_MINOR,
      platform: this.platform,
      client_id: this.clientId,
      timestamp,
      mac,
    });
    if (ack.kind !== 'hello_ack') {
      this.close();
      throw new Error(ack.code === 'unauthorized' ? 'unauthorized' : 'handshake_failed');
    }
    this.token = ack.session_token;
    return this;
  }

  async status() {
    const r = await this._request({ kind: 'status_request', session_token: this.token, platform: null });
    if (r.kind !== 'status') throw new Error(r.message || 'status_failed');
    return r;
  }

  async _platformCall(kind, platform) {
    const r = await this._request({ kind, session_token: this.token, platform });
    if (r.kind === 'event') return r.state;
    throw new Error(r.message || `${kind}_failed`);
  }

  protect(platform) {
    return this._platformCall('protect_request', platform);
  }

  autoProtect(platform) {
    return this._platformCall('auto_protect_request', platform);
  }

  off(platform) {
    return this._platformCall('disconnect_request', platform);
  }

  close() {
    if (this.sock) this.sock.destroy();
    this.sock = null;
  }
}

/** Run `fn(client)` against Core, always closing the connection. */
async function withCore(platform, fn) {
  const c = new CoreClient({ platform });
  try {
    await c.open();
    return await fn(c);
  } finally {
    c.close();
  }
}

/** Explain Core's route state without implying unsupported provider traffic is covered. */
function describe(st, platform) {
  if (!st) return 'SecureAI has no status for this tool yet.';
  switch (st.state) {
    case 'protected': {
      const route = st.traffic_seen_at
        ? 'SecureAI Core reports Protected for traffic observed on its route.'
        : 'SecureAI Core reports its route ready; no traffic has been observed yet.';
      if (platform === 'cursor') return `${route} Cursor’s own AI requests are not routed through SecureAI.`;
      if (platform === 'codex') return `${route} Codex cloud tools are not routed through SecureAI.`;
      if (platform === 'grok') return `${route} Remote Grok Bot traffic needs the separate relay.`;
      return route;
    }
    case 'requested':
    case 'connecting':
      return 'Turning on…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'failed':
      return 'Needs attention. Open SecureAI for details.';
    case 'unsupported':
      return 'Not available for this tool.';
    default:
      return st.desired ? 'Off for now — SecureAI will turn it back on shortly.' : 'Off.';
  }
}

function explainError(e) {
  switch (e && e.message) {
    case 'not_installed':
      return 'SecureAI isn’t installed on this computer.';
    case 'core_unreachable':
    case 'core_timeout':
      return 'SecureAI isn’t running right now.';
    case 'unauthorized':
      return 'SecureAI didn’t accept this request. Reinstalling SecureAI repairs its local key.';
    default:
      return 'SecureAI couldn’t complete that request.';
  }
}

module.exports = {
  CoreClient,
  withCore,
  findSecret,
  ipcPath,
  chronoTimestamp,
  describe,
  explainError,
  CUSTOMER_PLATFORMS,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
};
