FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app
COPY package.json ./
COPY src ./src

# Use the numeric UID so Kubernetes can verify runAsNonRoot before startup.
USER 1000:1000
EXPOSE 3000
CMD ["node", "src/index.js"]
