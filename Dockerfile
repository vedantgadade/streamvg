FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eux; base=https://github.com/yt-dlp/yt-dlp/releases/latest/download; cd /tmp; \
    curl -fsSL "$base/yt-dlp_linux" -o yt-dlp_linux; curl -fsSL "$base/SHA2-256SUMS" -o SHA2-256SUMS; \
    grep ' yt-dlp_linux$' SHA2-256SUMS | sha256sum -c -; \
    install -m 0755 yt-dlp_linux /usr/local/bin/yt-dlp; rm -f yt-dlp_linux SHA2-256SUMS
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
ENV NODE_ENV=production
CMD ["npm","start"]