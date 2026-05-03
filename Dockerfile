FROM node:20-alpine

# Install git + build toolchain required by Baileys deps
RUN apk add --no-cache git python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV AUTH_DIR=/data
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
