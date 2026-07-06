FROM node:22-alpine
RUN apk add --no-cache bash python3 make g++ linux-headers
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN node -e "require('/app/node_modules/node-pty'); console.log('node-pty OK')"
RUN npm link

ENV HOME=/workspace
ENV DOCKER=1
ENV SHELL=/bin/bash

# Make workspace writable by anyone so host user can write to mounted volume
RUN mkdir -p /workspace && chmod 777 /workspace

WORKDIR /workspace
EXPOSE 3000
RUN printf '#!/bin/sh\numask 000\nexec node /app/server.js\n' > /start.sh && chmod +x /start.sh
CMD ["/start.sh"]

