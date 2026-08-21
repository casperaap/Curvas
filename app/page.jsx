'use client';
import { useEffect, useRef, useState } from 'react';
import Pusher from 'pusher-js';

const COLORS = ['#e0245e', '#1d9bf0', '#17bf63', '#f5a623', '#9b59b6', '#e67e22'];

export default function Canvas() {
  const [others, setOthers] = useState({});
  const [me] = useState(() => ({
    id: Math.random().toString(36).slice(2, 8),
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  }));
  const socketIdRef = useRef(null);

  // --- agents panel state ---
  const [agents, setAgents] = useState({}); // id -> {provider, busy, log:[{who,text}]}
  const [sel, setSel] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [token, setToken] = useState('');
  const [bridgeAt, setBridgeAt] = useState(0);
  const [, forceTick] = useState(0);
  const logRef = useRef(null);
  const selRef = useRef(null);
  selRef.current = sel;

  useEffect(() => {
    setToken(localStorage.getItem('bridge-token') || '');
    const pusher = new Pusher(process.env.NEXT_PUBLIC_PUSHER_KEY, {
      cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER,
    });
    pusher.connection.bind('connected', () => {
      socketIdRef.current = pusher.connection.socket_id;
    });

    // cursors
    const canvasCh = pusher.subscribe('canvas');
    canvasCh.bind('cursor', (data) => {
      if (data.id === me.id) return;
      setOthers((prev) => ({ ...prev, [data.id]: { ...data, at: Date.now() } }));
    });
    let last = 0;
    const onMove = (e) => {
      const now = Date.now();
      if (now - last < 50) return;
      last = now;
      fetch('/api/cursor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: me.id,
          color: me.color,
          x: e.clientX / window.innerWidth,
          y: e.clientY / window.innerHeight,
          socketId: socketIdRef.current,
        }),
      });
    };
    window.addEventListener('mousemove', onMove);
    const gc = setInterval(() => {
      setOthers((prev) => {
        const next = {};
        for (const [id, c] of Object.entries(prev)) if (Date.now() - c.at < 6000) next[id] = c;
        return next;
      });
      forceTick((t) => t + 1); // refresh bridge-status dot
    }, 2000);

    // agents
    const ensure = (prev, id, provider) =>
      prev[id] ? prev : { ...prev, [id]: { provider, busy: false, log: [] } };
    const append = (prev, id, entry, mergeAgent) => {
      const a = prev[id] ?? { provider: '?', busy: false, log: [] };
      const log = [...a.log];
      if (mergeAgent && log.length && log[log.length - 1].who === 'agent') {
        log[log.length - 1] = { who: 'agent', text: log[log.length - 1].text + entry.text };
      } else log.push(entry);
      return { ...prev, [id]: { ...a, log } };
    };
    const agentsCh = pusher.subscribe('agents');
    agentsCh.bind('cmd', (c) => {
      if (c.op === 'create') setAgents((p) => ensure(p, c.agentId, c.provider));
      if (c.op === 'prompt')
        setAgents((p) => append(p, c.agentId, { who: 'user', from: c.from, text: c.text }));
    });
    agentsCh.bind('evt', (e) => {
      if (e.kind === 'bridge') {
        setBridgeAt(Date.now());
        if (e.agents)
          setAgents((p) => {
            let next = p;
            for (const [id, info] of Object.entries(e.agents)) {
              next = ensure(next, id, info.provider);
              next = { ...next, [id]: { ...next[id], busy: info.busy } };
            }
            return next;
          });
        return;
      }
      const id = e.agentId;
      if (e.kind === 'created') {
        setAgents((p) => ensure(p, id, e.provider));
        if (!selRef.current) setSel(id);
      } else if (e.kind === 'output') {
        setAgents((p) => append(p, id, { who: 'agent', text: e.text }, true));
      } else if (e.kind === 'error') {
        setAgents((p) => append(p, id, { who: 'error', text: e.text }));
      } else if (e.kind === 'status') {
        setAgents((p) => (p[id] ? { ...p, [id]: { ...p[id], busy: true } } : p));
      } else if (e.kind === 'done') {
        setAgents((p) => (p[id] ? { ...p, [id]: { ...p[id], busy: false } } : p));
      }
    });

    return () => {
      window.removeEventListener('mousemove', onMove);
      clearInterval(gc);
      pusher.disconnect();
    };
  }, [me]);

  useEffect(() => {
    logRef.current?.scrollTo(0, 1e9);
  }, [agents, sel]);

  const api = (cmd) =>
    fetch('/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, ...cmd }),
    }).then((r) => {
      if (r.status === 401) alert('Wrong token — enter the shared token at the top of the panel.');
    });

  const createAgent = (provider) => {
    const id = provider + '-' + Math.random().toString(36).slice(2, 6);
    api({ op: 'create', agentId: id, provider });
    setSel(id);
  };
  const send = () => {
    const text = prompt.trim();
    if (!text || !sel) return;
    setPrompt('');
    api({ op: 'prompt', agentId: sel, text, from: me.id });
  };

  const bridgeOk = Date.now() - bridgeAt < 70000;
  const a = sel ? agents[sel] : null;
  const font = { fontFamily: 'ui-sans-serif, system-ui, sans-serif' };

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#fafafa', position: 'relative', display: 'flex' }}>
      {/* agents panel */}
      <div style={{ width: 340, height: '100%', background: '#16181d', color: '#ddd', display: 'flex', flexDirection: 'column', flexShrink: 0, zIndex: 20, ...font }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #2a2d34', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 9, height: 9, borderRadius: 5, background: bridgeOk ? '#17bf63' : '#e0245e' }} />
          <b style={{ fontSize: 13 }}>Agents</b>
          <span style={{ fontSize: 11, color: '#888' }}>{bridgeOk ? 'bridge online' : 'bridge offline'}</span>
          <input
            placeholder="token"
            value={token}
            onChange={(e) => { setToken(e.target.value); localStorage.setItem('bridge-token', e.target.value); }}
            style={{ marginLeft: 'auto', width: 90, background: '#0d0f12', border: '1px solid #2a2d34', color: '#ddd', borderRadius: 6, padding: '3px 6px', fontSize: 11 }}
          />
        </div>
        <div style={{ padding: 8, display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid #2a2d34' }}>
          {Object.entries(agents).map(([id, ag]) => (
            <button key={id} onClick={() => setSel(id)}
              style={{ background: sel === id ? '#2f6feb' : '#22252c', color: '#fff', border: 'none', borderRadius: 8, padding: '4px 9px', fontSize: 12, cursor: 'pointer' }}>
              {ag.busy ? '● ' : ''}{id}
            </button>
          ))}
          <button onClick={() => createAgent('claude')} style={{ background: '#c96f4a', color: '#fff', border: 'none', borderRadius: 8, padding: '4px 9px', fontSize: 12, cursor: 'pointer' }}>+ Claude</button>
          <button onClick={() => createAgent('codex')} style={{ background: '#3d4450', color: '#fff', border: 'none', borderRadius: 8, padding: '4px 9px', fontSize: 12, cursor: 'pointer' }}>+ Codex</button>
        </div>
        <div ref={logRef} style={{ flex: 1, overflowY: 'auto', padding: 10, fontSize: 12.5, lineHeight: 1.45 }}>
          {!a && <div style={{ color: '#777' }}>Create an agent, or pick one above. Prompts and replies are shared live with everyone on this page.</div>}
          {a?.log.map((m, i) => (
            <div key={i} style={{ marginBottom: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {m.who === 'user' && <div style={{ color: '#7ab7ff' }}><b>{m.from ?? 'user'}:</b> {m.text}</div>}
              {m.who === 'agent' && <div style={{ color: '#ddd' }}>{m.text}</div>}
              {m.who === 'error' && <div style={{ color: '#ff8097' }}>{m.text}</div>}
            </div>
          ))}
          {a?.busy && <div style={{ color: '#888' }}>thinking…</div>}
        </div>
        <div style={{ padding: 10, borderTop: '1px solid #2a2d34', display: 'flex', gap: 6 }}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={sel ? `Prompt ${sel}…` : 'Select an agent first'}
            rows={2}
            style={{ flex: 1, resize: 'none', background: '#0d0f12', border: '1px solid #2a2d34', color: '#ddd', borderRadius: 8, padding: 8, fontSize: 12.5, ...font }}
          />
          <button onClick={send} disabled={!sel} style={{ background: '#2f6feb', color: '#fff', border: 'none', borderRadius: 8, padding: '0 14px', cursor: 'pointer', opacity: sel ? 1 : 0.4 }}>➤</button>
        </div>
      </div>

      {/* cursor canvas */}
      <div style={{ flex: 1, position: 'relative' }}>
        <div style={{ position: 'absolute', top: 12, left: 12, color: '#999', fontSize: 13, ...font }}>
          You are <b style={{ color: me.color }}>{me.id}</b> — {Object.keys(others).length} other(s) online
        </div>
      </div>

      {Object.values(others).map((c) => (
        <div key={c.id}
          style={{ position: 'absolute', left: `${c.x * 100}%`, top: `${c.y * 100}%`, pointerEvents: 'none', transition: 'left 60ms linear, top 60ms linear', zIndex: 30 }}>
          <svg width="20" height="20" viewBox="0 0 20 20">
            <path d="M2 2 L18 9 L10 11 L7 18 Z" fill={c.color} stroke="#fff" strokeWidth="1" />
          </svg>
          <span style={{ background: c.color, color: '#fff', fontSize: 11, padding: '2px 6px', borderRadius: 8, marginLeft: 12, ...font }}>
            {c.id}
          </span>
        </div>
      ))}
    </div>
  );
}
