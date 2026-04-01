# DNS Configuration Guide

This document explains all DNS records required for a fully functional, high-deliverability mail server.

---

## Required DNS Records

Replace `mail.example.com` and `YOUR_SERVER_IP` with your actual values.

### 1. A Record — Mail Server Hostname

| Type | Host | Value | TTL |
|------|------|-------|-----|
| A | `mail.example.com` | `YOUR_SERVER_IP` | 3600 |

This is the hostname of your mail server. All other records point to or are validated against this.

---

### 2. MX Record — Mail Exchanger

| Type | Host | Priority | Value | TTL |
|------|------|----------|-------|-----|
| MX | `example.com` | 10 | `mail.example.com` | 3600 |

Tells other mail servers where to deliver email for your domain.

For redundancy, add a secondary MX:
| MX | `example.com` | 20 | `mail2.example.com` | 3600 |

---

### 3. SPF Record — Sender Policy Framework

| Type | Host | Value | TTL |
|------|------|-------|-----|
| TXT | `example.com` | `v=spf1 ip4:YOUR_SERVER_IP ~all` | 3600 |

**Options for the final mechanism:**
- `~all` — softfail (recommended when starting; fails but delivers)
- `-all` — hardfail (strict; rejects unauthorized senders)
- `+all` — pass all (never use this)

**If using multiple mail providers:**
```
v=spf1 ip4:YOUR_SERVER_IP include:sendgrid.net include:amazonses.com ~all
```

> **Limit:** Only one SPF TXT record per domain. Multiple records cause failures.

---

### 4. DKIM Record — DomainKeys Identified Mail

Generated via Admin Panel → DNS Wizard → Generate DKIM Keys.

| Type | Host | Value | TTL |
|------|------|-------|-----|
| TXT | `mail._domainkey.example.com` | `v=DKIM1; k=rsa; p=<PUBLIC_KEY>` | 3600 |

The public key (`p=`) is a long base64 string from your DKIM key generation.

**Note:** Some DNS providers have a 255-character limit per TXT record string. If your key is longer, split it:
```
"v=DKIM1; k=rsa; p=MIIBIjANBgkqh..." "kiG8w0BAQEFAAOCAQ8A..."
```

---

### 5. DMARC Record — Domain-based Message Authentication

| Type | Host | Value | TTL |
|------|------|-------|-----|
| TXT | `_dmarc.example.com` | `v=DMARC1; p=none; rua=mailto:dmarc-reports@example.com` | 3600 |

**Recommended rollout:**
1. **Start:** `p=none` — monitor only, no enforcement
2. **After 2 weeks with clean reports:** `p=quarantine; pct=10` — quarantine 10% of failures
3. **Production:** `p=reject; pct=100` — reject all failures

**Full DMARC record example:**
```
v=DMARC1; p=reject; adkim=r; aspf=r; rua=mailto:dmarc@example.com; ruf=mailto:forensics@example.com; pct=100
```

| Tag | Meaning |
|-----|---------|
| `p=` | Policy: none / quarantine / reject |
| `adkim=r` | DKIM alignment: r=relaxed, s=strict |
| `aspf=r` | SPF alignment: r=relaxed, s=strict |
| `rua=` | Aggregate report destination |
| `ruf=` | Forensic report destination |
| `pct=` | Percentage of messages to apply policy to |

---

### 6. PTR Record — Reverse DNS (rDNS)

**This is the most critical record for email deliverability.**

Set at your hosting provider (not your DNS registrar):
- `YOUR_SERVER_IP` → `mail.example.com`

For AWS EC2: Elastic IPs > Actions > Update Reverse DNS  
For Azure: Public IP > Configuration > Reverse FQDN  
For DigitalOcean: Droplets > Networking > Add PTR  

---

### 7. BIMI Record (Optional — Brand Indicators)

Requires DMARC at `p=quarantine` or `p=reject` and a VMC certificate.

| Type | Host | Value | TTL |
|------|------|-------|-----|
| TXT | `default._bimi.example.com` | `v=BIMI1; l=https://example.com/logo.svg; a=https://example.com/vmc.pem` | 3600 |

---

## DNS Propagation

After adding records, propagation takes 5 minutes to 48 hours. Check with:

```bash
# Check MX
dig MX example.com

# Check SPF
dig TXT example.com | grep spf

# Check DKIM
dig TXT mail._domainkey.example.com

# Check DMARC
dig TXT _dmarc.example.com

# Check PTR
dig -x YOUR_SERVER_IP
```

---

## Deliverability Testing

After configuring DNS, test with:
- [mail-tester.com](https://www.mail-tester.com) — send test email, get score
- [MXToolbox](https://mxtoolbox.com/SuperTool.aspx) — check all records
- [DMARC Analyzer](https://www.dmarcanalyzer.com) — DMARC validation
- [Google Postmaster Tools](https://postmaster.google.com) — Gmail reputation
- [Microsoft SNDS](https://sendersupport.olc.protection.outlook.com/snds/) — Outlook reputation

---

## Minimum Records for Receiving Email

```
A     mail.example.com   →  YOUR_SERVER_IP
MX    example.com        →  mail.example.com (priority 10)
```

## Minimum Records for Sending Email (Good Deliverability)

```
A     mail.example.com   →  YOUR_SERVER_IP
MX    example.com        →  mail.example.com
TXT   example.com        →  v=spf1 ip4:YOUR_SERVER_IP ~all
TXT   mail._domainkey.example.com  →  v=DKIM1; k=rsa; p=<KEY>
TXT   _dmarc.example.com →  v=DMARC1; p=none; rua=mailto:dmarc@example.com
PTR   YOUR_SERVER_IP     →  mail.example.com
```
