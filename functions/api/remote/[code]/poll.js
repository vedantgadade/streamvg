export async function onRequestGet({ env, params }) {
  const code = String(params.code || "");
  if (!/^[a-f0-9]{32}$/.test(code)) {
    return Response.json({ error: "Invalid TV connection." }, { status: 400 });
  }

  const store = env.REMOTE_SESSIONS;
  if (!store) {
    return Response.json({ error: "Remote storage is not configured yet. Add the REMOTE_SESSIONS KV binding in Cloudflare Pages." }, { status: 503 });
  }

  const raw = await store.get(code);
  if (!raw) {
    return Response.json({ error: "This TV connection has expired. Create a new QR code." }, {
      status: 410,
      headers: { "Cache-Control": "no-store" }
    });
  }

  const value = JSON.parse(raw);
  const remaining = Math.floor((value.expiresAt - Date.now()) / 1000);
  if (remaining <= 0) {
    await store.delete(code);
    return Response.json({ error: "This TV connection has expired. Create a new QR code." }, {
      status: 410,
      headers: { "Cache-Control": "no-store" }
    });
  }

  const url = value.pendingUrl || null;
  if (url) {
    value.pendingUrl = null;
    await store.put(code, JSON.stringify(value), { expirationTtl: remaining });
  }

  return Response.json({ url, expiresIn: remaining }, {
    headers: { "Cache-Control": "no-store" }
  });
}
