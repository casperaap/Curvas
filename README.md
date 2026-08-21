# Curvas

A minimal shared cursor canvas built with Next.js and Pusher. People on the same URL can see one another's cursors move in real time.

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local` and add your Pusher credentials.
3. Run `npm run dev`.
4. Open `http://localhost:3456`.

The development server listens on `0.0.0.0`, so another device on the same network can connect through your computer's LAN IP on port `3456` when the firewall allows it.

