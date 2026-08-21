// Agent bridge: runs on Casper's PC. Subscribes to the Pusher `agents` channel,
// spawns local `claude` / `codex` CLIs per agent, streams output back to Pusher.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Pusher from 'pusher';
import PusherClient from 'pusher-js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const WORKSPACE = path.join(root, 'workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });
const STATE_FILE = path.join(dir, 'state.json');
const state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  : { agents: {} };
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const server = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true,
});
const evt = (data) =>
  server.trigger('agents', 'evt', data).catch((e) => console.error('trigger failed:', e.message));

const runners = {}; // agentId -> { busy, queue }

function makeStreamer(agentId) {
  let buf = '';
  const flush = () => {
    if (!buf) return;
    const chunk = buf.slice(0, 8000); // Pusher caps events at 10KB
    buf = buf.slice(8000);
    evt({ agentId, kind: 'output', text: chunk });
  };
  const timer = setInterval(flush, 350);
  return {
    push: (t) => { buf += t; },
    end: () => { clearInterval(timer); do { flush(); } while (buf); },
  };
}

function runClaude(id, a, text, done) {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  ];
  if (a.sessionId) args.push('--resume', a.sessionId);
  const p = spawn('claude', args, { cwd: WORKSPACE, shell: true });
  p.stdin.write(text);
  p.stdin.end();
  const s = makeStreamer(id);
  let lineBuf = '';
  p.stdout.on('data', (d) => {
    lineBuf += d;
    let i;
    while ((i = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, i).trim();
      lineBuf = lineBuf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.session_id) { a.sessionId = m.session_id; save(); }
      if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text') s.push(b.text + '\n');
          else if (b.type === 'tool_use') s.push(`⚙ ${b.name}\n`);
        }
      }
      if (m.type === 'result' && m.is_error) s.push(`[error] ${m.result ?? ''}\n`);
    }
  });
  p.stderr.on('data', (d) => s.push(String(d)));
  p.on('close', (code) => {
    s.end();
    if (code) evt({ agentId: id, kind: 'error', text: `claude exited ${code}` });
    done();
  });
}

function runCodex(id, a, text, done) {
  const base = ['--sandbox', 'workspace-write', '--skip-git-repo-check', '-'];
  const args = a.started ? ['exec', 'resume', '--last', ...base] : ['exec', ...base];
  const p = spawn('codex', args, { cwd: WORKSPACE, shell: true });
  p.stdin.write(text);
  p.stdin.end();
  const s = makeStreamer(id);
  p.stdout.on('data', (d) => s.push(String(d)));
  p.stderr.on('data', (d) => s.push(String(d)));
  p.on('close', (code) => {
    a.started = true;
    save();
    s.end();
    if (code) evt({ agentId: id, kind: 'error', text: `codex exited ${code}` });
    done();
  });
}

function handlePrompt(id, text) {
  const r = (runners[id] ??= { busy: false, queue: [] });
  if (r.busy) {
    r.queue.push(text);
    evt({ agentId: id, kind: 'status', text: 'queued' });
    return;
  }
  r.busy = true;
  evt({ agentId: id, kind: 'status', text: 'running' });
  const a = state.agents[id];
  const done = () => {
    r.busy = false;
    evt({ agentId: id, kind: 'done' });
    const next = r.queue.shift();
    if (next) handlePrompt(id, next);
  };
  try {
    (a.provider === 'codex' ? runCodex : runClaude)(id, a, text, done);
  } catch (e) {
    r.busy = false;
    evt({ agentId: id, kind: 'error', text: e.message });
  }
}

const heartbeat = () =>
  evt({
    kind: 'bridge',
    agents: Object.fromEntries(
      Object.entries(state.agents).map(([k, v]) => [
        k,
        { provider: v.provider, busy: runners[k]?.busy ?? false },
      ])
    ),
  });

const client = new PusherClient(process.env.PUSHER_KEY, {
  cluster: process.env.PUSHER_CLUSTER,
});
client.connection.bind('connected', () => {
  console.log('bridge online, workspace:', WORKSPACE);
  heartbeat();
});
const ch = client.subscribe('agents');
ch.bind('cmd', (c) => {
  console.log('cmd:', c.op, c.agentId ?? '');
  if (c.op === 'create') {
    if (!state.agents[c.agentId]) {
      state.agents[c.agentId] = { provider: c.provider };
      save();
    }
    evt({ agentId: c.agentId, kind: 'created', provider: c.provider });
    heartbeat();
  } else if (c.op === 'prompt') {
    if (!state.agents[c.agentId])
      return evt({ agentId: c.agentId, kind: 'error', text: 'unknown agent' });
    handlePrompt(c.agentId, c.text);
  }
});
setInterval(heartbeat, 30000);
