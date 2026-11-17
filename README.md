# StreamVG

Free web video player and streaming diagnostics tool.

Features: direct MP4/WebM, HLS, DASH, local playback, quality selection, diagnostics, subtitles, A-B loop, sleep timer, resume, history, sharing and optional public-stream proxy. Unsupported local-file codecs can be transcoded in the browser to H.264/AAC MP4 with FFmpeg WebAssembly; the selected file stays on the device.

Run:
npm install
npm run dev

Production:
npm run build
npm start

Production note: browser URL history navigation is handled with the browser History API.


Deployment and monetization readiness:
- Cloudflare Pages can build `main` with `npm run build` and publish `dist`.
- Set `VITE_API_BASE_URL` on the Pages project to the Railway backend URL so browser API calls reach the resolver.
- SEO essentials include canonical metadata, robots.txt, sitemap.xml and dedicated informational pages.
- The site is prepared for later AdSense integration without fake publisher IDs or ad code. Add Google-provided code only after approval and policy review.
- The resolver uses yt-dlp when available and falls back to page/media extraction. It does not bypass DRM, passwords, or access controls.
