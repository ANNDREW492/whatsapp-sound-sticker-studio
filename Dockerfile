FROM denoland/deno:2

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY deno.json ./
COPY src ./src
COPY public ./public

RUN deno cache src/server.ts

ENV HOST=0.0.0.0
ENV PORT=3000
ENV PERSIST_LOCAL_SESSION=false
ENV MAX_SESSIONS=12
ENV SESSION_TTL_MIN=10
ENV MAX_CONCURRENT_FFMPEG=2

EXPOSE 3000

CMD ["deno", "run", "-A", "src/server.ts"]
