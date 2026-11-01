# Outage Desk: no npm dependencies, so the image is just Node and the app.
FROM node:24.14.0-slim

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

# ping for the optional per-client connection check (falls back to TCP without it).
RUN apt-get update \
 && apt-get install -y --no-install-recommends iputils-ping ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# cloudflared for the home side of a two-site setup; runs only when
# TUNNEL_TOKEN is set. Pinned version, checked against its checksum.
ARG TARGETARCH
ARG CLOUDFLARED_VERSION=2026.9.1
RUN set -eu; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) sum=03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc ;; \
      arm64) sum=3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3 ;; \
      *) echo "no cloudflared for $arch; the tunnel will be unavailable"; exit 0 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${arch}"; \
    echo "$sum  /usr/local/bin/cloudflared" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/cloudflared

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node web ./web
COPY --chown=node:node fixtures ./fixtures
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server/index.js"]
