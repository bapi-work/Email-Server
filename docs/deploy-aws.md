# Deployment Guide — Amazon Web Services (AWS)

---

## Architecture Overview

```
Internet
    │
    ├── Port 25/465/587 (SMTP)    ─→  EC2 Instance (CloudMail)
    ├── Port 143/993 (IMAP)       ─→  EC2 Instance (CloudMail)
    ├── Port 110/995 (POP3)       ─→  EC2 Instance (CloudMail)
    └── Port 80/443 (HTTP/S)      ─→  EC2 Instance (Nginx → CloudMail)
                                           │
                              ┌────────────┴────────────┐
                          RDS PostgreSQL           ElastiCache Redis
                        (managed database)      (optional, or EC2 Redis)
```

---

## Prerequisites

- AWS account with IAM permissions for EC2, RDS, Security Groups, Elastic IP
- AWS CLI configured (`aws configure`)
- A registered domain name with DNS managed in Route 53 or external registrar

---

## Step 1: EC2 Instance

### Launch Instance

```bash
# Recommended: t3.medium or t3.large for production
aws ec2 run-instances \
  --image-id ami-0c55b159cbfafe1f0 \     # Ubuntu 22.04 LTS (update for your region)
  --instance-type t3.medium \
  --key-name your-key-pair \
  --security-group-ids sg-XXXXXXXXX \
  --subnet-id subnet-XXXXXXXXX \
  --associate-public-ip-address \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":50,"VolumeType":"gp3"}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=cloudmail}]'
```

### Recommended Instance Sizes

| Load | Instance | vCPU | RAM | Cost/mo |
|------|----------|------|-----|---------|
| Small (<1000 mailboxes) | t3.medium | 2 | 4GB | ~$30 |
| Medium (1000-10k) | t3.large | 2 | 8GB | ~$60 |
| Large (10k+) | c5.xlarge | 4 | 8GB | ~$120 |

### Allocate and Associate Elastic IP

```bash
# Allocate Elastic IP (required for email — dynamic IPs are blocked)
ALLOC=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)
aws ec2 associate-address --instance-id i-XXXXXXXXX --allocation-id $ALLOC

# Get the IP
aws ec2 describe-addresses --allocation-ids $ALLOC --query 'Addresses[0].PublicIp' --output text
```

> **Critical:** AWS blocks outbound port 25 by default. You must submit a [PTR/rDNS request](https://aws.amazon.com/forms/ec2-email-limit-rdns-request) and request removal of the port 25 restriction.

---

## Step 2: Security Groups

```bash
aws ec2 create-security-group \
  --group-name cloudmail-sg \
  --description "CloudMail Mail Server"

SG_ID=$(aws ec2 describe-security-groups --group-names cloudmail-sg --query 'SecurityGroups[0].GroupId' --output text)

# Allow mail protocols
for PORT in 25 465 587 143 993 110 995 80 443; do
  aws ec2 authorize-security-group-ingress \
    --group-id $SG_ID \
    --protocol tcp \
    --port $PORT \
    --cidr 0.0.0.0/0
done

# Allow SSH (restrict to your IP)
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp \
  --port 22 \
  --cidr YOUR_IP/32
```

---

## Step 3: RDS PostgreSQL (Managed Database)

```bash
# Create DB subnet group
aws rds create-db-subnet-group \
  --db-subnet-group-name cloudmail-db-subnet \
  --db-subnet-group-description "CloudMail DB" \
  --subnet-ids subnet-AAAA subnet-BBBB

# Create RDS instance
aws rds create-db-instance \
  --db-instance-identifier cloudmail-db \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --engine-version 16.2 \
  --master-username cloudmail \
  --master-user-password YOUR_STRONG_PASSWORD \
  --db-name cloudmail \
  --allocated-storage 20 \
  --storage-type gp3 \
  --storage-encrypted \
  --no-publicly-accessible \
  --vpc-security-group-ids $SG_ID \
  --db-subnet-group-name cloudmail-db-subnet \
  --backup-retention-period 7 \
  --deletion-protection

# Wait for it to be available
aws rds wait db-instance-available --db-instance-identifier cloudmail-db

# Get endpoint
aws rds describe-db-instances \
  --db-instance-identifier cloudmail-db \
  --query 'DBInstances[0].Endpoint.Address' \
  --output text
```

### Update .env for RDS

```bash
# In your .env file on the EC2 instance:
DB_HOST=cloudmail-db.xxxxxxxx.us-east-1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=cloudmail
DB_USER=cloudmail
DB_PASSWORD=YOUR_STRONG_PASSWORD
DB_SSL=true
# Download RDS CA certificate:
# wget https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -O /etc/ssl/certs/rds-ca.pem
DB_SSL_CA=/etc/ssl/certs/rds-ca.pem
```

---

## Step 4: ElastiCache Redis (Optional)

```bash
aws elasticache create-cache-cluster \
  --cache-cluster-id cloudmail-redis \
  --engine redis \
  --cache-node-type cache.t3.micro \
  --num-cache-nodes 1 \
  --security-group-ids $SG_ID

# Get endpoint
aws elasticache describe-cache-clusters \
  --cache-cluster-id cloudmail-redis \
  --show-cache-node-info \
  --query 'CacheClusters[0].CacheNodes[0].Endpoint'
```

---

## Step 5: Install CloudMail

```bash
# SSH into EC2 instance
ssh -i your-key.pem ubuntu@YOUR_ELASTIC_IP

# Clone or upload CloudMail files
git clone https://github.com/your-org/cloudmail.git /opt/cloudmail
cd /opt/cloudmail

# Run installer
sudo bash scripts/install-ubuntu.sh mail.yourdomain.com admin@yourdomain.com

# Or with Docker Compose
cp .env.example .env
# Edit .env with your RDS and ElastiCache endpoints
docker compose up -d
```

---

## Step 6: Route 53 DNS

```bash
HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name yourdomain.com \
  --query 'HostedZones[0].Id' --output text | sed 's|/hostedzone/||')

# Create DNS records
aws route53 change-resource-record-sets \
  --hosted-zone-id $HOSTED_ZONE_ID \
  --change-batch '{
    "Changes": [
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "mail.yourdomain.com",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "YOUR_ELASTIC_IP"}]
        }
      },
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "yourdomain.com",
          "Type": "MX",
          "TTL": 300,
          "ResourceRecords": [{"Value": "10 mail.yourdomain.com"}]
        }
      },
      {
        "Action": "CREATE",
        "ResourceRecordSet": {
          "Name": "yourdomain.com",
          "Type": "TXT",
          "TTL": 300,
          "ResourceRecords": [{"Value": "\"v=spf1 ip4:YOUR_ELASTIC_IP ~all\""}]
        }
      }
    ]
  }'
```

### PTR Record (Reverse DNS)
Submit via [AWS support form](https://aws.amazon.com/forms/ec2-email-limit-rdns-request):
- Elastic IP: `YOUR_ELASTIC_IP`
- PTR: `mail.yourdomain.com`
- Reason: Self-hosted mail server

---

## Step 7: SSL via ACM / Let's Encrypt

```bash
# On the EC2 instance, use Let's Encrypt
sudo bash scripts/setup-ssl.sh mail.yourdomain.com admin@yourdomain.com
```

---

## Step 8: S3 for Mail Storage (Optional)

For large installations, store raw messages in S3 instead of local disk.

```bash
# Create S3 bucket
aws s3 mb s3://cloudmail-messages-yourdomain --region us-east-1

# Add to .env:
# MAIL_STORAGE_BACKEND=s3
# AWS_S3_BUCKET=cloudmail-messages-yourdomain
# AWS_REGION=us-east-1
```

---

## Backup

```bash
# Automated RDS snapshots (already configured with --backup-retention-period 7)
# Manual snapshot:
aws rds create-db-snapshot \
  --db-instance-identifier cloudmail-db \
  --db-snapshot-identifier cloudmail-backup-$(date +%Y%m%d)

# S3 backup of mail data:
aws s3 sync /var/cloudmail s3://your-backup-bucket/cloudmail/$(date +%Y%m%d)/
```

---

## Cost Estimate (us-east-1)

| Resource | Spec | Monthly Cost |
|----------|------|-------------|
| EC2 t3.medium | 2 vCPU, 4GB | ~$30 |
| Elastic IP | 1 IP | ~$4 |
| RDS db.t3.micro | PostgreSQL 16 | ~$15 |
| EBS gp3 50GB | Storage | ~$4 |
| Data transfer | 100GB out | ~$9 |
| **Total** | | **~$62/mo** |

With docker-compose on a single EC2 (no RDS/ElastiCache): ~$35/mo
