# Runs the bot on Linux hosts like Railway.
FROM node:20-slim

# Python + Pillow draw the grail graphics; Tesseract reads the PSA slab labels.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pil tesseract-ocr ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# Posting times (CHASE_TIMES) are in this timezone. Override with a TZ variable on the host if needed.
ENV TZ=Asia/Kolkata
CMD ["node", "src/index.js"]
