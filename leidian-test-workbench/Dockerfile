FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.html styles.css app.js server.js README.md ./
COPY docs ./docs
COPY samples ./samples

RUN mkdir -p /app/data /app/data/runs

ENV PORT=5785
EXPOSE 5785

CMD ["node", "server.js"]
