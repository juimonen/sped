FROM node:22-alpine
RUN apk add --no-cache bash python3 make g++ linux-headers
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN node -e "require('/app/node_modules/node-pty'); console.log('node-pty OK')"
RUN npm link

# Set a friendly prompt
RUN echo "export PS1='sped> '" >> /etc/profile
RUN echo "export PS1='sped> '" >> /root/.bashrc
RUN echo '[ -f /etc/profile ] && . /etc/profile' >> /root/.bash_profile

ENV HOME=/workspace
ENV DOCKER=1
ENV SHELL=/bin/bash
WORKDIR /workspace
EXPOSE 3000
CMD ["node", "/app/server.js"]
