FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=9000

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY web ./web

EXPOSE 9000

CMD ["node", "src/server.js"]
