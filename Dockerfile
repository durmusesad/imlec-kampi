FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js bots.js blackjack.js raceline.json raceline3d.json ./
COPY public ./public
ENV NODE_ENV=production
CMD ["node", "server.js"]
