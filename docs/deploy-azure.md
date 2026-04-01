# Deployment Guide — Microsoft Azure

---

## Architecture Overview

```
Internet
    │
    └── Azure VM (Ubuntu 22.04) ─── CloudMail (Docker or bare-metal)
              │
    ┌─────────┴─────────┐
Azure DB for PostgreSQL  Azure Cache for Redis
   (Flexible Server)        (optional)
```

---

## Prerequisites

- Azure account with Contributor role
- Azure CLI installed and logged in (`az login`)
- A registered domain (Azure DNS or external)

---

## Step 1: Resource Group

```bash
az group create \
  --name cloudmail-rg \
  --location eastus
```

---

## Step 2: Virtual Machine

```bash
# Create VM with static IP
az vm create \
  --resource-group cloudmail-rg \
  --name cloudmail-vm \
  --image Ubuntu2204 \
  --size Standard_B2s \
  --admin-username azureuser \
  --generate-ssh-keys \
  --public-ip-sku Standard \
  --public-ip-address cloudmail-ip \
  --os-disk-size-gb 50

# Get the public IP
az network public-ip show \
  --resource-group cloudmail-rg \
  --name cloudmail-ip \
  --query ipAddress --output tsv
```

### Recommended VM Sizes

| Load | Size | vCPU | RAM | Cost/mo |
|------|------|------|-----|---------|
| Small | Standard_B2s | 2 | 4GB | ~$32 |
| Medium | Standard_B4ms | 4 | 16GB | ~$65 |
| Large | Standard_D4s_v3 | 4 | 16GB | ~$140 |

---

## Step 3: Network Security Group

```bash
# Get NSG name (auto-created with VM)
NSG=$(az network nsg list -g cloudmail-rg --query '[0].name' -o tsv)

# Allow mail ports
for PORT in 25 465 587 143 993 110 995 80 443; do
  az network nsg rule create \
    --resource-group cloudmail-rg \
    --nsg-name $NSG \
    --name allow-mail-$PORT \
    --priority $((1000 + PORT)) \
    --destination-port-ranges $PORT \
    --protocol Tcp \
    --access Allow \
    --direction Inbound
done
```

> **Note:** Azure does not block port 25 for pay-as-you-go subscriptions by default, but may restrict it for free/trial accounts. Open a support ticket if needed.

---

## Step 4: Azure Database for PostgreSQL (Flexible Server)

```bash
az postgres flexible-server create \
  --resource-group cloudmail-rg \
  --name cloudmail-db \
  --location eastus \
  --admin-user cloudmail \
  --admin-password YOUR_STRONG_PASSWORD \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --version 16 \
  --storage-size 32 \
  --backup-retention 7 \
  --database-name cloudmail

# Allow VM to connect (use VM's private IP in production)
az postgres flexible-server firewall-rule create \
  --resource-group cloudmail-rg \
  --name cloudmail-db \
  --rule-name allow-vm \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 255.255.255.255  # Restrict to VM IP in production

# Get connection string
az postgres flexible-server show \
  --resource-group cloudmail-rg \
  --name cloudmail-db \
  --query fullyQualifiedDomainName -o tsv
```

### .env for Azure PostgreSQL

```bash
DB_HOST=cloudmail-db.postgres.database.azure.com
DB_PORT=5432
DB_NAME=cloudmail
DB_USER=cloudmail
DB_PASSWORD=YOUR_STRONG_PASSWORD
DB_SSL=true
# Download Azure CA: https://dl.cacerts.digicert.com/DigiCertGlobalRootCA.crt.pem
DB_SSL_CA=/etc/ssl/certs/azure-postgres-ca.pem
```

---

## Step 5: Azure Cache for Redis (Optional)

```bash
az redis create \
  --resource-group cloudmail-rg \
  --name cloudmail-redis \
  --location eastus \
  --sku Basic \
  --vm-size c0

# Get connection string
az redis show \
  --resource-group cloudmail-rg \
  --name cloudmail-redis \
  --query [hostName,sslPort] -o tsv

# Get access key
az redis list-keys \
  --resource-group cloudmail-rg \
  --name cloudmail-redis \
  --query primaryKey -o tsv
```

### .env for Azure Redis

```bash
REDIS_URL=rediss://:YOUR_KEY@cloudmail-redis.redis.cache.windows.net:6380
```

---

## Step 6: Install CloudMail on VM

```bash
# SSH to VM
ssh azureuser@YOUR_VM_IP

# Clone and install
git clone https://github.com/your-org/cloudmail /opt/cloudmail
cd /opt/cloudmail
sudo bash scripts/install-ubuntu.sh mail.yourdomain.com admin@yourdomain.com
```

---

## Step 7: Azure DNS

```bash
# Create DNS zone (or use external registrar)
az network dns zone create \
  --resource-group cloudmail-rg \
  --name yourdomain.com

# A record
az network dns record-set a add-record \
  --resource-group cloudmail-rg \
  --zone-name yourdomain.com \
  --record-set-name mail \
  --ipv4-address YOUR_VM_IP

# MX record
az network dns record-set mx add-record \
  --resource-group cloudmail-rg \
  --zone-name yourdomain.com \
  --record-set-name "@" \
  --preference 10 \
  --exchange mail.yourdomain.com

# SPF TXT record
az network dns record-set txt add-record \
  --resource-group cloudmail-rg \
  --zone-name yourdomain.com \
  --record-set-name "@" \
  --value "v=spf1 ip4:YOUR_VM_IP ~all"

# DMARC TXT record
az network dns record-set txt add-record \
  --resource-group cloudmail-rg \
  --zone-name yourdomain.com \
  --record-set-name "_dmarc" \
  --value "v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com"
```

### PTR Record (Reverse DNS)

```bash
# Set reverse DNS on the public IP
az network public-ip update \
  --resource-group cloudmail-rg \
  --name cloudmail-ip \
  --reverse-fqdn mail.yourdomain.com
```

---

## Step 8: SSL Certificate

```bash
# On the VM
sudo bash /opt/cloudmail/scripts/setup-ssl.sh mail.yourdomain.com admin@yourdomain.com
```

---

## Backup

```bash
# Azure PostgreSQL — automated backups are included (7-day retention configured above)

# Manual backup to Azure Blob Storage
az storage container create \
  --account-name yourstorageaccount \
  --name cloudmail-backup

az storage blob upload-batch \
  --source /var/cloudmail \
  --destination cloudmail-backup/$(date +%Y%m%d) \
  --account-name yourstorageaccount
```

---

## Cost Estimate (East US)

| Resource | Spec | Monthly Cost |
|----------|------|-------------|
| VM Standard_B2s | 2 vCPU, 4GB | ~$32 |
| Public IP (Standard) | 1 IP | ~$4 |
| Azure DB PostgreSQL (B1ms) | 1 vCPU, 2GB | ~$25 |
| Managed disk 50GB | P6 SSD | ~$6 |
| **Total** | | **~$67/mo** |

Single VM with Docker (no managed DB): ~$36/mo
