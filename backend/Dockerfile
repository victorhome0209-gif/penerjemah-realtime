# Backend VocalBridge. Tidak ada rahasia di image: semua dibaca dari environment variables saat jalan.
FROM node:22-slim
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
EXPOSE 8787
CMD ["node", "server.js"]
