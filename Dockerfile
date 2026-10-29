FROM node:22-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN npm install --production

COPY src ./src

CMD ["npx", "tsx", "src/app.ts"]
