FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js plan-store.js auth.js schedule.js schema.sql ./
COPY discord.js discord-interactions.js jobs.js ./
COPY index.html app.js calculator.js schedule-merge.js styles.css ./
COPY login.html login.js admin.html admin.js ./
COPY assets ./assets
COPY scripts ./scripts
RUN mkdir -p /app/data

ENV HOST=0.0.0.0
ENV PORT=4173
EXPOSE 4173

CMD ["node", "server.js"]
