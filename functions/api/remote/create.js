export async function onRequestPost({ request }) {
  const code = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = Date.now() + 15 * 60 * 1000;
  const key = new Request(new URL("/__streamvg_remote_sessions/" + code, request.url).toString());
  const value = { expiresAt, pendingUrl: null };
  await caches.default.put(key, new Response(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=900"
    }
  }));
  return Response.json({ code, expiresIn: 900 }, {
    headers: { "Cache-Control": "no-store" }
  });
}
