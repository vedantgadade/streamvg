export async function onRequestPost({ request, params }) {
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

  const cache = caches.default;
  const key = new Request(new URL("/__streamvg_remote_sessions/" + code, request.url).toString());
  const stored = await cache.match(key);
  if (!stored) {
    return Response.json({ error: "This TV connection has expired. Scan a new QR code." }, {
      status: 410,
      headers: { "Cache-Control": "no-store" }
    });
  }

  const value = await stored.json();
  const remaining = Math.floor((value.expiresAt - Date.now()) / 1000);
  if (remaining <= 0) {
    await cache.delete(key);
    return Response.json({ error: "This TV connection has expired. Scan a new QR code." }, {
      status: 410,
      headers: { "Cache-Control": "no-store" }
    });
  }

  value.pendingUrl = url;
  await cache.put(key, new Response(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=" + remaining
    }
  }));

  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
