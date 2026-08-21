import Pusher from 'pusher';

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true,
});

export async function POST(req) {
  const body = await req.json();
  if (process.env.BRIDGE_TOKEN && body.token !== process.env.BRIDGE_TOKEN) {
    return new Response('bad token', { status: 401 });
  }
  const { token, ...cmd } = body;
  await pusher.trigger('agents', 'cmd', cmd);
  return Response.json({ ok: true });
}
