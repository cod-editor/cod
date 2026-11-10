FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 \
    libatk-bridge2.0-0 libdrm2 libx11-xcb1 libxkbcommon0 fonts-liberation \
    ca-certificates procps util-linux git unzip xdotool \
    && rm -rf /var/lib/apt/lists/*
