FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
ENV AUTH_DIR=/data

EXPOSE 3000
CMD ["node", "server.js"]
