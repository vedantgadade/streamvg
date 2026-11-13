export async function onRequestGet({ request, params }) {
  const code = String(params.code || "");
  if (!/^[a-f0-9]{32}$/.test(code)) {
    return Response.json({ error: "Invalid TV connection." }, { status: 400 });
  }

  const cache = caches.default;
  const key = new Request(new URL("/__streamvg_remote_sessions/" + code, request.url).toString());
  const stored = await cache.match(key);
  if (!stored) {
    return Response.json({ error: "This TV connection has expired. Create a new QR code." }, {
      status: 410,
      headers: { "Cache-Control": "no-store" }
    });
  }

  const value = await stored.json();
  const remaining = Math.floor((value.expiresAt - Date.now()) / 1000);
  if (remaining <= 0) {
    await cache.delete(key);
    return Response.json({ error: "This TV connection has expired. Create a new QR code." }, {
      status: 410,
      headers: { "Cache-Control": "no-store" }
    });
  }

  const url = value.pendingUrl || null;
  if (url) {
    value.pendingUrl = null;
    await cache.put(key, new Response(JSON.stringify(value), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=" + remaining
      }
    }));
  }

  return Response.json({ url, expiresIn: remaining }, {
    headers: { "Cache-Control": "no-store" }
  });
}
