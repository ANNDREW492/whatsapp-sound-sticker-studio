FROM denoland/deno:debian-2.9.8

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY deno.json deno.lock ./
COPY src ./src
COPY public ./public

RUN deno install --entrypoint src/server.ts

ENV HOST=0.0.0.0
ENV PORT=3000
ENV PERSIST_LOCAL_SESSION=false
ENV MAX_SESSIONS=6
ENV SESSION_TTL_MIN=10
ENV MAX_CONCURRENT_FFMPEG=1
ENV FFMPEG_THREADS=1

EXPOSE 3000

CMD ["deno", "run", "-A", "src/server.ts"]
