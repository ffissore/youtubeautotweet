FROM node:12-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY index.js sources.json ./

CMD node index.js
