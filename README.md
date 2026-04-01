# CloudMail Server

A production-grade, self-hosted mail server with full protocol support, web interfaces, and bulk email capabilities.

## Features

| Feature | Details |
|---------|---------|
| **SMTP** | Inbound (port 25), Submission (587), SMTPS (465) |
| **IMAP4rev1** | Plain (143), IMAPS (993) — full RFC 3501 command set |
| **POP3** | Plain (110), POP3S (995) |
| **Webmail** | Responsive browser-based email client |
| **Admin Panel** | Full web dashboard for domain/mailbox/campaign management |
| **DKIM** | Per-domain RSA key generation and email signing |
| **SPF** | Inbound verification + DNS record generator |
| **DMARC** | Policy enforcement (none/quarantine/reject) + record generator |
| **Bulk Email** | Campaign management with Redis queue, open/click tracking |
| **Multi-domain** | Unlimited domains, each with independent DKIM/SPF/DMARC |
| **Aliases** | Email aliases with forwarding to any address |
| **Blocklist** | Block by email, domain, or IP |
| **Audit Logs** | Full admin action logging |
| **TLS** | STARTTLS on all protocols, SSL variants on secure ports |

---

## Quick Start with Docker

### 1. Clone & Configure

```bash
git clone https://github.com/your-org/cloudmail.git
cd cloudmail
cp .env.example .env
```

Edit `.env` — minimum required changes:
```ini
DB_PASSWORD=change_this_strong_password
JWT_SECRET=change_this_to_64_random_chars
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=change_this_strong_password
```

### 2. Generate SSL (dev)

```bash
make ssl-self
# For production, use: make ssl-certbot DOMAIN=mail.yourdomain.com EMAIL=admin@yourdomain.com
```

### 3. Start

```bash
make up
# or: docker compose up -d
```

### 4. Access

| Interface | URL |
|-----------|-----|
| Webmail | http://localhost/webmail |
| Admin Panel | http://localhost/admin |
| API | http://localhost/api/health |

### 5. Add Your Domain

1. Log in to **Admin Panel** with your `ADMIN_EMAIL` / `ADMIN_PASSWORD`
2. Go to **Domains → Add Domain** → enter `yourdomain.com`
3. Go to **DNS Wizard** → select your domain → copy DNS records to your registrar
4. Go to **Mailboxes → Add Mailbox** → create `user@yourdomain.com`

---

## Production Deployment

### Docker Compose (any Linux server)

```bash
# On your server
git clone https://github.com/your-org/cloudmail.git && cd cloudmail
cp .env.example .env && nano .env  # configure fully
docker compose up -d
```

### Ubuntu Bare-Metal

```bash
sudo bash scripts/install-ubuntu.sh mail.yourdomain.com admin@yourdomain.com
```

### Cloud Platforms

| Platform | Guide |
|----------|-------|
| AWS (EC2 + RDS) | [docs/deploy-aws.md](docs/deploy-aws.md) |
| Azure (VM + Azure DB) | [docs/deploy-azure.md](docs/deploy-azure.md) |
| DigitalOcean (Droplet + Managed DB) | [docs/deploy-digitalocean.md](docs/deploy-digitalocean.md) |

---

## DNS Configuration

After deploying, configure these DNS records at your domain registrar:

| Type | Host | Value | Required |
|------|------|-------|---------|
| A | `mail.yourdomain.com` | `YOUR_SERVER_IP` | ✓ |
| MX | `yourdomain.com` | `mail.yourdomain.com` (priority 10) | ✓ |
| TXT | `yourdomain.com` | `v=spf1 ip4:YOUR_IP ~all` | ✓ |
| TXT | `mail._domainkey.yourdomain.com` | *(from DNS Wizard)* | ✓ |
| TXT | `_dmarc.yourdomain.com` | `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com` | Recommended |
| PTR | `YOUR_SERVER_IP` | `mail.yourdomain.com` | Critical for deliverability |

See [docs/dns-setup.md](docs/dns-setup.md) for the full DNS guide.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  CloudMail Process (Node.js)                                │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │   SMTP   │  │   IMAP   │  │   POP3   │  │  HTTP    │  │
│  │ 25/587/  │  │  143/993 │  │  110/995 │  │ (3000)   │  │
│  │   465    │  │          │  │          │  │ API+UI   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │              │              │              │        │
│  ┌────▼──────────────▼──────────────▼──────────────▼────┐  │
│  │               Core Services Layer                    │  │
│  │  DkimService · SpfService · DmarcService             │  │
│  │  MessageStore · SmtpClient · BulkEmailQueue          │  │
│  └───────────────────────┬───────────────────────────────┘  │
│                           │                               │
│  ┌────────────────────────▼───────────────────────────┐  │
│  │            PostgreSQL · Redis                      │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Directory Structure

```
cloudmail/
├── src/
│   ├── server.js                  # Entry point — starts all servers
│   ├── config/index.js            # All configuration from env
│   ├── database/
│   │   ├── connection.js          # PostgreSQL pool
│   │   ├── migrate.js             # Migration runner
│   │   └── migrations/
│   │       └── 001_initial.sql    # Full schema
│   ├── services/
│   │   ├── smtp/
│   │   │   ├── SmtpServer.js      # Inbound SMTP (25/587/465)
│   │   │   └── SmtpClient.js      # Outbound delivery
│   │   ├── imap/ImapServer.js     # IMAP4rev1 server (143/993)
│   │   ├── pop3/Pop3Server.js     # POP3 server (110/995)
│   │   ├── dkim/DkimService.js    # DKIM sign/verify/generate
│   │   ├── spf/SpfService.js      # SPF check + DMARC evaluate
│   │   ├── queue/BulkEmailQueue.js # Bull queue for campaigns
│   │   └── storage/MessageStore.js # Message persistence
│   ├── api/
│   │   ├── app.js                 # Express app + middleware
│   │   ├── middleware/authenticate.js
│   │   └── routes/
│   │       ├── auth.js            # Admin login/logout
│   │       ├── domains.js         # Domain management
│   │       ├── mailboxes.js       # Mailbox CRUD
│   │       ├── aliases.js         # Alias management
│   │       ├── messages.js        # Message/log admin API
│   │       ├── campaigns.js       # Bulk email campaigns
│   │       ├── settings.js        # DNS wizard, DKIM, blocklist, stats
│   │       └── webmail.js         # Webmail API (auth + messages)
│   ├── utils/logger.js            # Winston logger
│   └── web/
│       ├── admin/
│       │   ├── index.html         # Admin SPA
│       │   └── admin.js           # Admin JavaScript
│       └── webmail/
│           ├── index.html         # Webmail SPA
│           └── webmail.js         # Webmail JavaScript
├── scripts/
│   ├── install-ubuntu.sh          # Automated Ubuntu installer
│   ├── setup-ssl.sh               # Let's Encrypt setup
│   └── generate-dkim.js           # CLI DKIM key generator
├── nginx/
│   ├── nginx.conf                 # Main Nginx config
│   └── conf.d/mailserver.conf     # Vhost config
├── docs/
│   ├── dns-setup.md               # DNS records guide
│   ├── deploy-aws.md              # AWS deployment guide
│   ├── deploy-azure.md            # Azure deployment guide
│   ├── deploy-digitalocean.md     # DigitalOcean guide
│   └── ubuntu-bare-metal.md       # Bare-metal Ubuntu guide
├── Dockerfile
├── docker-compose.yml
├── Makefile                       # Convenience commands
├── package.json
└── .env.example
```

---

## Makefile Commands

```bash
make help          # Show all available commands
make up            # Start all Docker services
make down          # Stop all services
make build         # Rebuild the image
make logs          # Follow mailserver logs
make migrate       # Run database migrations
make shell         # Shell into the container
make psql          # PostgreSQL shell
make redis-cli     # Redis CLI
make ssl-self      # Generate self-signed cert (dev)
make ssl-certbot   # Get Let's Encrypt cert
make status        # Show service status
make clean         # Remove all data volumes (DESTRUCTIVE)
```

---

## API Reference

All API endpoints are at `/api/`. Admin endpoints require a JWT token (obtained from `/api/auth/login`). Webmail endpoints use `/api/webmail/`.

### Admin API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Admin login |
| GET | `/api/auth/me` | Get current admin |
| GET | `/api/domains` | List domains |
| POST | `/api/domains` | Add domain |
| GET | `/api/mailboxes` | List mailboxes |
| POST | `/api/mailboxes` | Create mailbox |
| GET | `/api/aliases` | List aliases |
| POST | `/api/aliases` | Create alias |
| GET | `/api/campaigns` | List campaigns |
| POST | `/api/campaigns` | Create campaign |
| POST | `/api/campaigns/:id/recipients` | Upload recipients |
| POST | `/api/campaigns/:id/send` | Start campaign |
| GET | `/api/settings/stats` | Dashboard stats |
| GET | `/api/settings/dns/:domainId` | DNS record wizard |
| POST | `/api/settings/dkim/generate/:domainId` | Generate DKIM keys |
| GET | `/api/messages/logs/smtp` | SMTP delivery log |

### Webmail API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/webmail/auth/login` | Mailbox login |
| GET | `/api/webmail/folders` | List IMAP folders |
| GET | `/api/webmail/messages` | List messages |
| GET | `/api/webmail/messages/:id` | Get message |
| POST | `/api/webmail/messages` | Send / save draft |
| PATCH | `/api/webmail/messages/:id` | Update flags / move |
| DELETE | `/api/webmail/messages/:id` | Delete / trash |

---

## Environment Variables

See [.env.example](.env.example) for the full list with descriptions.

Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_PASSWORD` | ✓ | PostgreSQL password |
| `JWT_SECRET` | ✓ | 64+ char random string |
| `ADMIN_EMAIL` | ✓ | Initial admin email |
| `ADMIN_PASSWORD` | ✓ | Initial admin password |
| `REDIS_HOST` | — | Redis host (default: localhost) |
| `TLS_KEY` / `TLS_CERT` | — | SSL certificate paths |
| `DKIM_SELECTOR` | — | DKIM selector name (default: mail) |
| `SMTP_RELAY_HOST` | — | Optional outbound SMTP relay |

---

## Email Client Configuration

| Setting | Value |
|---------|-------|
| **IMAP** | `mail.yourdomain.com:993` SSL/TLS |
| **POP3** | `mail.yourdomain.com:995` SSL/TLS |
| **SMTP** | `mail.yourdomain.com:587` STARTTLS |
| **Username** | `user@yourdomain.com` |
| **Password** | mailbox password |

---

## License

MIT
