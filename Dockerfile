FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV APP_PORT=4613
ENV APP_HOST=0.0.0.0

COPY package.json ./
COPY src ./src

RUN mkdir -p data uploads

EXPOSE 4613

CMD ["node", "src/server/index.js"]
