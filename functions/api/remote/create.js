export async function onRequestPost({ env }) {
  const store = env.REMOTE_SESSIONS;
  if (!store) {
    return Response.json({ error: "Remote storage is not configured yet. Add the REMOTE_SESSIONS KV binding in Cloudflare Pages." }, { status: 503 });
  }

  const code = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = Date.now() + 15 * 60 * 1000;
  await store.put(code, JSON.stringify({ expiresAt, pendingUrl: null }), {
    expirationTtl: 900
  });

  return Response.json({ code, expiresIn: 900 }, {
    headers: { "Cache-Control": "no-store" }
  });
}
