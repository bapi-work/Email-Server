# Deployment Guide — DigitalOcean

DigitalOcean is one of the easiest platforms for self-hosted mail servers: straightforward PTR record management, no port 25 blocking by default (on qualified accounts), and simple managed databases.

---

## Architecture Overview

```
Internet
    │
    └── Droplet (Ubuntu 22.04) ─── CloudMail
              │
    ┌─────────┴─────────┐
DO Managed PostgreSQL   DO Managed Redis
  (optional, paid)     (optional, paid)
```

---

## Prerequisites

- DigitalOcean account
- `doctl` CLI: `brew install doctl` or [install instructions](https://docs.digitalocean.com/reference/doctl/how-to/install/)
- Authenticate: `doctl auth init`

---

## Step 1: Create a Droplet

```bash
# List available images
doctl compute image list --public | grep ubuntu

# Create droplet
doctl compute droplet create cloudmail \
  --image ubuntu-22-04-x64 \
  --size s-2vcpu-4gb \
  --region nyc3 \
  --ssh-keys $(doctl compute ssh-key list --format ID --no-header | head -1) \
  --tag-names cloudmail \
  --wait

# Get IP address
doctl compute droplet get cloudmail --format PublicIPv4 --no-header
```

### Recommended Droplet Sizes

| Load | Size | vCPU | RAM | Cost/mo |
|------|------|------|-----|---------|
| Small (<500 mailboxes) | s-2vcpu-4gb | 2 | 4GB | $24 |
| Medium | s-4vcpu-8gb | 4 | 8GB | $48 |
| Large | s-8vcpu-16gb | 8 | 16GB | $96 |

> Use **Regular SSD** droplets for mail storage; NVMe is overkill for most mail workloads.

---

## Step 2: Reserve IP / Floating IP

```bash
# Create a reserved IP (equivalent to static/elastic IP)
doctl compute reserved-ip create --region nyc3

# Assign to droplet
doctl compute reserved-ip assign YOUR_RESERVED_IP YOUR_DROPLET_ID
```

---

## Step 3: Firewall Rules

```bash
# Create firewall
doctl compute firewall create \
  --name cloudmail-fw \
  --inbound-rules "protocol:tcp,ports:22,address:YOUR_IP/32 \
                   protocol:tcp,ports:25,address:0.0.0.0/0,::/0 \
                   protocol:tcp,ports:465,address:0.0.0.0/0,::/0 \
                   protocol:tcp,ports:587,address:0.0.0.0/0,::/0 \
                   protocol:tcp,ports:143,address:0.0.0.0/0,::/0 \
                   protocol:tcp,ports:993,address:0.0.0.0/0,::/0 \
                   protocol:tcp,ports:110,address:0.0.0.0/0,::/0 \
                   protocol:tcp,ports:995,address:0.0.0.0/0,::/0 \
                   protocol:tcp,ports:80,address:0.0.0.0/0,::/0 \
                   protocol:tcp,ports:443,address:0.0.0.0/0,::/0" \
  --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0,::/0 \
                    protocol:udp,ports:all,address:0.0.0.0/0,::/0" \
  --droplet-ids $(doctl compute droplet get cloudmail --format ID --no-header)
```

---

## Step 4: PTR Record (Reverse DNS)

DigitalOcean makes PTR records easy — no support ticket needed.

```bash
# Using doctl
doctl compute droplet get cloudmail --format ID --no-header
# Then in DigitalOcean panel: Networking → Droplets → Your Droplet → PTR record

# Or via API:
curl -X PUT \
  -H "Authorization: Bearer $DO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ptr_record": "mail.yourdomain.com"}' \
  "https://api.digitalocean.com/v2/floating_ips/YOUR_RESERVED_IP/actions"
```

Or in the **Dashboard**: Networking → Reserved IPs → click your IP → Edit PTR Record → set to `mail.yourdomain.com`

---

## Step 5: Managed PostgreSQL (Optional)

```bash
doctl databases create cloudmail-db \
  --engine pg \
  --version 16 \
  --region nyc3 \
  --size db-s-1vcpu-1gb \
  --num-nodes 1

# Get connection string
doctl databases connection cloudmail-db --format URI --no-header

# Add your droplet to trusted sources
doctl databases firewalls append cloudmail-db \
  --rule droplet:$(doctl compute droplet get cloudmail --format ID --no-header)
```

### .env for Managed PostgreSQL

```bash
# Parse from the connection URI or set individually:
DB_HOST=cloudmail-db-do-user-XXXXXX-0.db.ondigitalocean.com
DB_PORT=25060
DB_NAME=defaultdb
DB_USER=doadmin
DB_PASSWORD=YOUR_PASSWORD
DB_SSL=true
# DO CA cert
DB_SSL_CA=/etc/ssl/certs/do-postgres-ca.pem
# Download: https://www.digicert.com/CACerts/BaltimoreCyberTrustRoot.crt.pem
```

---

## Step 6: Managed Redis (Optional)

```bash
doctl databases create cloudmail-redis \
  --engine redis \
  --version 7 \
  --region nyc3 \
  --size db-s-1vcpu-1gb \
  --num-nodes 1

doctl databases connection cloudmail-redis --format URI --no-header
```

### .env for Managed Redis

```bash
REDIS_URL=rediss://default:PASSWORD@cloudmail-redis-do-user-XXXXX-0.db.ondigitalocean.com:25061
```

---

## Step 7: Install CloudMail

```bash
# SSH to droplet
ssh root@YOUR_RESERVED_IP

# Clone and install
git clone https://github.com/your-org/cloudmail /opt/cloudmail
cd /opt/cloudmail

# Bare-metal installation
bash scripts/install-ubuntu.sh mail.yourdomain.com admin@yourdomain.com

# --- OR Docker Compose ---
cp .env.example .env
# Edit .env with your DB/Redis/domain config
apt-get install -y docker.io docker-compose-plugin
docker compose up -d
```

---

## Step 8: DigitalOcean DNS

```bash
# Add domain to DigitalOcean DNS (optional if using external DNS)
doctl compute domain create yourdomain.com --ip-address YOUR_RESERVED_IP

# A record for mail subdomain
doctl compute domain records create yourdomain.com \
  --record-type A \
  --record-name mail \
  --record-data YOUR_RESERVED_IP \
  --record-ttl 3600

# MX record
doctl compute domain records create yourdomain.com \
  --record-type MX \
  --record-name @ \
  --record-data mail.yourdomain.com \
  --record-priority 10 \
  --record-ttl 3600

# SPF
doctl compute domain records create yourdomain.com \
  --record-type TXT \
  --record-name @ \
  --record-data "v=spf1 ip4:YOUR_RESERVED_IP ~all" \
  --record-ttl 3600

# DMARC
doctl compute domain records create yourdomain.com \
  --record-type TXT \
  --record-name _dmarc \
  --record-data "v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com" \
  --record-ttl 3600
```

After generating DKIM via admin panel, add it:
```bash
doctl compute domain records create yourdomain.com \
  --record-type TXT \
  --record-name mail._domainkey \
  --record-data "v=DKIM1; k=rsa; p=YOUR_DKIM_PUBLIC_KEY" \
  --record-ttl 3600
```

---

## Step 9: SSL Certificate

```bash
# On the droplet
bash /opt/cloudmail/scripts/setup-ssl.sh mail.yourdomain.com admin@yourdomain.com
```

---

## DigitalOcean Spaces for Mail Storage (Optional)

```bash
# Create a Space (S3-compatible object storage)
# In the dashboard: Spaces → Create Space → nyc3 → cloudmail-messages
# Then add to .env:
# DO_SPACES_KEY=your-key
# DO_SPACES_SECRET=your-secret
# DO_SPACES_ENDPOINT=nyc3.digitaloceanspaces.com
# DO_SPACES_BUCKET=cloudmail-messages
```

---

## Backup

```bash
# Enable Droplet Backups (20% of monthly cost):
doctl compute droplet-action enable-backups YOUR_DROPLET_ID

# Snapshot on demand:
doctl compute droplet-action snapshot YOUR_DROPLET_ID --snapshot-name "cloudmail-$(date +%Y%m%d)"

# Managed DB: automatic daily backups with 7-day retention are included
```

---

## Cost Estimate

| Resource | Spec | Monthly Cost |
|----------|------|-------------|
| Droplet s-2vcpu-4gb | 2 vCPU, 4GB | $24 |
| Reserved IP | 1 IP | $4 |
| Managed DB (1vcpu-1gb) | PostgreSQL | $15 |
| 50GB Block Storage | SSD | $5 |
| **Total (with managed DB)** | | **~$48/mo** |
| **Total (single droplet)** | | **~$28/mo** |

DigitalOcean is the most cost-effective option for small-to-medium mail servers.
