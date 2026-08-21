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

  useEffect(() => {
    const pusher = new Pusher(process.env.NEXT_PUBLIC_PUSHER_KEY, {
      cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER,
    });
    pusher.connection.bind('connected', () => {
      socketIdRef.current = pusher.connection.socket_id;
    });
    const channel = pusher.subscribe('canvas');
    channel.bind('cursor', (data) => {
      if (data.id === me.id) return;
      setOthers((prev) => ({ ...prev, [data.id]: { ...data, at: Date.now() } }));
    });

    let last = 0;
    const onMove = (e) => {
      const now = Date.now();
      if (now - last < 50) return; // ~20 msgs/sec max
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

    // drop cursors idle for >6s
    const gc = setInterval(() => {
      setOthers((prev) => {
        const next = {};
        for (const [id, c] of Object.entries(prev)) {
          if (Date.now() - c.at < 6000) next[id] = c;
        }
        return next;
      });
    }, 2000);

    return () => {
      window.removeEventListener('mousemove', onMove);
      clearInterval(gc);
      pusher.disconnect();
    };
  }, [me]);

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#fafafa', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 12, left: 12, fontFamily: 'sans-serif', color: '#999', fontSize: 13 }}>
        You are <b style={{ color: me.color }}>{me.id}</b> — {Object.keys(others).length} other(s) online
      </div>
      {Object.values(others).map((c) => (
        <div
          key={c.id}
          style={{
            position: 'absolute',
            left: `${c.x * 100}%`,
            top: `${c.y * 100}%`,
            pointerEvents: 'none',
            transition: 'left 60ms linear, top 60ms linear',
            zIndex: 10,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20">
            <path d="M2 2 L18 9 L10 11 L7 18 Z" fill={c.color} stroke="#fff" strokeWidth="1" />
          </svg>
          <span
            style={{
              background: c.color,
              color: '#fff',
              fontFamily: 'sans-serif',
              fontSize: 11,
              padding: '2px 6px',
              borderRadius: 8,
              marginLeft: 12,
            }}
          >
            {c.id}
          </span>
        </div>
      ))}
    </div>
  );
}
