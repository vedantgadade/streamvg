export async function onRequestPost({ request, env, params }) {
  const code = String(params.code || "");
  if (!/^[a-f0-9]{32}$/.test(code)) {
    return Response.json({ error: "Invalid TV connection." }, { status: 400 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const url = String(body?.url || "").trim();
  if (url.length > 8192) {
    return Response.json({ error: "The video URL is too long." }, { status: 413 });
  }
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid protocol");
  } catch {
    return Response.json({ error: "Please enter a valid http or https video URL." }, { status: 400 });
  }

  const store = env.REMOTE_SESSIONS;
  if (!store) {
    return Response.json({ error: "Remote storage is not configured yet. Add the REMOTE_SESSIONS KV binding in Cloudflare Pages." }, { status: 503 });
  }

  const raw = await store.get(code);
  if (!raw) {
    return Response.json({ error: "This TV connection has expired. Scan a new QR code." }, {
      status: 410,
      headers: { "Cache-Control": "no-store" }
    });
  }

  const value = JSON.parse(raw);
  const remaining = Math.floor((value.expiresAt - Date.now()) / 1000);
  if (remaining <= 0) {
    await store.delete(code);
    return Response.json({ error: "This TV connection has expired. Scan a new QR code." }, {
      status: 410,
      headers: { "Cache-Control": "no-store" }
    });
  }

  value.pendingUrl = url;
  await store.put(code, JSON.stringify(value), { expirationTtl: remaining });

  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
