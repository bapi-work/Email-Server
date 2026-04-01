FROM node:20-alpine

# Install system tools needed for crypto, DNS, etc.
RUN apk add --no-cache \
    openssl \
    ca-certificates \
    bind-tools \
    tzdata \
    curl

# Create non-root user
RUN addgroup -g 1001 cloudmail && adduser -u 1001 -G cloudmail -s /bin/sh -D cloudmail

WORKDIR /app

# Install dependencies first (cache layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY src/ ./src/

# Create runtime directories
RUN mkdir -p \
    /var/cloudmail/messages \
    /var/cloudmail/attachments \
    /var/log/cloudmail \
    /etc/cloudmail/dkim \
    /etc/ssl/cloudmail && \
    chown -R cloudmail:cloudmail /var/cloudmail /var/log/cloudmail /etc/cloudmail /etc/ssl/cloudmail

USER cloudmail

EXPOSE 25 465 587 143 993 110 995 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "src/server.js"]
