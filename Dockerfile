FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV PORT=8686
EXPOSE 8686
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8686/health || exit 1
USER node
CMD ["node", "server.js"]
