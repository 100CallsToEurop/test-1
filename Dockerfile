FROM node:26-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY .env.example ./.env.example

ENV PORT=3011
EXPOSE 3011

CMD ["node", "src/server.js"]
