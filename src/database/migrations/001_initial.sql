-- CloudMail Server - Initial Database Schema
-- Run with: psql -U cloudmail -d cloudmail -f 001_initial.sql

BEGIN;

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- DOMAINS
-- ============================================================
CREATE TABLE IF NOT EXISTS domains (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    -- DKIM
    dkim_selector     VARCHAR(100) DEFAULT 'mail',
    dkim_private_key  TEXT,
    dkim_public_key   TEXT,
    dkim_enabled      BOOLEAN DEFAULT FALSE,
    -- SPF / DMARC
    spf_record        TEXT,
    dmarc_policy      VARCHAR(20) DEFAULT 'none' CHECK (dmarc_policy IN ('none','quarantine','reject')),
    dmarc_rua         VARCHAR(255),
    dmarc_pct         INTEGER DEFAULT 100,
    -- Quotas
    default_quota_mb  INTEGER DEFAULT 1024,
    -- Status
    active      BOOLEAN DEFAULT TRUE,
    catch_all   VARCHAR(255),  -- email address to receive unmatched mail
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ADMIN USERS (web admin access)
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_users (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name     VARCHAR(255),
    role          VARCHAR(50) DEFAULT 'admin' CHECK (role IN ('superadmin','admin','viewer')),
    last_login    TIMESTAMPTZ,
    active        BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- MAILBOXES (email accounts)
-- ============================================================
CREATE TABLE IF NOT EXISTS mailboxes (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    domain_id     UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    username      VARCHAR(255) NOT NULL,  -- local part only (before @)
    password_hash VARCHAR(255) NOT NULL,
    full_name     VARCHAR(255),
    quota_mb      INTEGER DEFAULT 1024,
    used_bytes    BIGINT DEFAULT 0,
    -- IMAP UID tracking
    uid_validity  INTEGER DEFAULT 1,
    uid_next      INTEGER DEFAULT 1,
    -- Status
    active        BOOLEAN DEFAULT TRUE,
    can_send      BOOLEAN DEFAULT TRUE,
    can_receive   BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(username, domain_id)
);

-- ============================================================
-- FOLDERS (IMAP folders per mailbox)
-- ============================================================
CREATE TABLE IF NOT EXISTS folders (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mailbox_id    UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    name          VARCHAR(255) NOT NULL,  -- e.g. INBOX, Sent, Drafts, Trash, Spam
    parent_id     UUID REFERENCES folders(id) ON DELETE CASCADE,
    special_use   VARCHAR(50),  -- \Inbox \Sent \Drafts \Trash \Junk \Flagged
    subscribed    BOOLEAN DEFAULT TRUE,
    uid_validity  INTEGER DEFAULT 1,
    uid_next      INTEGER DEFAULT 1,
    total_msgs    INTEGER DEFAULT 0,
    unseen_msgs   INTEGER DEFAULT 0,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(mailbox_id, name)
);

-- ============================================================
-- MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mailbox_id      UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    folder_id       UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    uid             INTEGER NOT NULL,
    -- Envelope
    message_id      VARCHAR(998),
    subject         TEXT,
    from_address    TEXT NOT NULL,
    from_name       TEXT,
    to_addresses    JSONB DEFAULT '[]',
    cc_addresses    JSONB DEFAULT '[]',
    bcc_addresses   JSONB DEFAULT '[]',
    reply_to        TEXT,
    -- Content
    size_bytes      INTEGER DEFAULT 0,
    headers         JSONB DEFAULT '{}',
    body_text       TEXT,
    body_html       TEXT,
    has_attachments BOOLEAN DEFAULT FALSE,
    -- Raw storage path
    raw_path        TEXT,
    -- Flags (IMAP)
    flags           TEXT[] DEFAULT '{}',
    is_seen         BOOLEAN DEFAULT FALSE,
    is_flagged      BOOLEAN DEFAULT FALSE,
    is_answered     BOOLEAN DEFAULT FALSE,
    is_draft        BOOLEAN DEFAULT FALSE,
    is_deleted      BOOLEAN DEFAULT FALSE,  -- marked for expunge
    -- Authentication results
    spf_result      VARCHAR(20),
    dkim_result     VARCHAR(20),
    dmarc_result    VARCHAR(20),
    spam_score      DECIMAL(5,2),
    -- Tracking
    received_at     TIMESTAMPTZ DEFAULT NOW(),
    sent_at         TIMESTAMPTZ,
    UNIQUE(mailbox_id, folder_id, uid)
);

-- ============================================================
-- ATTACHMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS attachments (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    filename      VARCHAR(255),
    content_type  VARCHAR(255),
    size_bytes    INTEGER DEFAULT 0,
    storage_path  TEXT,
    inline        BOOLEAN DEFAULT FALSE,
    content_id    VARCHAR(255),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ALIASES
-- ============================================================
CREATE TABLE IF NOT EXISTS aliases (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    domain_id         UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    source_local      VARCHAR(255) NOT NULL,  -- local part before @
    destination       TEXT NOT NULL,           -- full email or local@domain
    active            BOOLEAN DEFAULT TRUE,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(source_local, domain_id)
);

-- ============================================================
-- SMTP DELIVERY LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS smtp_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id_hdr  VARCHAR(998),
    direction       VARCHAR(10) NOT NULL CHECK (direction IN ('inbound','outbound')),
    from_address    TEXT,
    to_address      TEXT,
    client_ip       INET,
    status          VARCHAR(20) NOT NULL CHECK (status IN ('accepted','rejected','deferred','delivered','bounced')),
    response_code   INTEGER,
    response_msg    TEXT,
    spf_result      VARCHAR(20),
    dkim_result     VARCHAR(20),
    dmarc_result    VARCHAR(20),
    bytes           INTEGER,
    logged_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- BULK EMAIL CAMPAIGNS
-- ============================================================
CREATE TABLE IF NOT EXISTS campaigns (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name              VARCHAR(255) NOT NULL,
    from_name         VARCHAR(255) NOT NULL,
    from_address      VARCHAR(255) NOT NULL,
    reply_to          VARCHAR(255),
    subject           TEXT NOT NULL,
    body_html         TEXT,
    body_text         TEXT,
    status            VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','paused','completed','cancelled')),
    scheduled_at      TIMESTAMPTZ,
    started_at        TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,
    total_recipients  INTEGER DEFAULT 0,
    sent_count        INTEGER DEFAULT 0,
    delivered_count   INTEGER DEFAULT 0,
    opened_count      INTEGER DEFAULT 0,
    clicked_count     INTEGER DEFAULT 0,
    bounced_count     INTEGER DEFAULT 0,
    failed_count      INTEGER DEFAULT 0,
    unsubscribed_count INTEGER DEFAULT 0,
    track_opens       BOOLEAN DEFAULT TRUE,
    track_clicks      BOOLEAN DEFAULT TRUE,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CAMPAIGN RECIPIENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS campaign_recipients (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id   UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    email         VARCHAR(255) NOT NULL,
    name          VARCHAR(255),
    variables     JSONB DEFAULT '{}',  -- template variables
    status        VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','queued','sent','delivered','opened','clicked','bounced','failed','unsubscribed')),
    message_id    VARCHAR(998),
    sent_at       TIMESTAMPTZ,
    opened_at     TIMESTAMPTZ,
    clicked_at    TIMESTAMPTZ,
    error         TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(campaign_id, email)
);

-- ============================================================
-- BLOCKED SENDERS / BLACKLIST
-- ============================================================
CREATE TABLE IF NOT EXISTS blocklist (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type        VARCHAR(20) NOT NULL CHECK (type IN ('email','domain','ip')),
    value       VARCHAR(255) NOT NULL,
    reason      TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(type, value)
);

-- ============================================================
-- GREYLISTING
-- ============================================================
CREATE TABLE IF NOT EXISTS greylist (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_ip       INET NOT NULL,
    from_address    TEXT NOT NULL,
    to_address      TEXT NOT NULL,
    first_seen      TIMESTAMPTZ DEFAULT NOW(),
    last_seen       TIMESTAMPTZ DEFAULT NOW(),
    pass_count      INTEGER DEFAULT 0,
    UNIQUE(client_ip, from_address, to_address)
);

-- ============================================================
-- SESSIONS (webmail/admin)
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID NOT NULL,
    user_type     VARCHAR(20) NOT NULL CHECK (user_type IN ('admin','mailbox')),
    token_hash    VARCHAR(255) NOT NULL UNIQUE,
    ip_address    INET,
    user_agent    TEXT,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AUDIT LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID,
    user_type   VARCHAR(20),
    action      VARCHAR(100) NOT NULL,
    resource    VARCHAR(100),
    resource_id VARCHAR(255),
    details     JSONB DEFAULT '{}',
    ip_address  INET,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SCHEMA MIGRATIONS TRACKING
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     VARCHAR(50) PRIMARY KEY,
    applied_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version) VALUES ('001_initial') ON CONFLICT DO NOTHING;

-- ============================================================
-- INDEXES
-- ============================================================

-- Mailboxes
CREATE INDEX IF NOT EXISTS idx_mailboxes_domain ON mailboxes(domain_id);
CREATE INDEX IF NOT EXISTS idx_mailboxes_username ON mailboxes(username);

-- Folders
CREATE INDEX IF NOT EXISTS idx_folders_mailbox ON folders(mailbox_id);

-- Messages
CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder_id);
CREATE INDEX IF NOT EXISTS idx_messages_uid ON messages(mailbox_id, folder_id, uid);
CREATE INDEX IF NOT EXISTS idx_messages_flags ON messages USING GIN(flags);
CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_is_seen ON messages(is_seen) WHERE NOT is_seen;
CREATE INDEX IF NOT EXISTS idx_messages_is_deleted ON messages(is_deleted) WHERE is_deleted;
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_address);
CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id);

-- Aliases
CREATE INDEX IF NOT EXISTS idx_aliases_domain ON aliases(domain_id);
CREATE INDEX IF NOT EXISTS idx_aliases_source ON aliases(source_local, domain_id);

-- SMTP logs
CREATE INDEX IF NOT EXISTS idx_smtp_logs_from ON smtp_logs(from_address);
CREATE INDEX IF NOT EXISTS idx_smtp_logs_to ON smtp_logs(to_address);
CREATE INDEX IF NOT EXISTS idx_smtp_logs_ip ON smtp_logs(client_ip);
CREATE INDEX IF NOT EXISTS idx_smtp_logs_date ON smtp_logs(logged_at DESC);

-- Campaigns
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign ON campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status ON campaign_recipients(campaign_id, status);

-- Sessions
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, user_type);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Blocklist
CREATE INDEX IF NOT EXISTS idx_blocklist_value ON blocklist(type, value);

-- Greylisting
CREATE INDEX IF NOT EXISTS idx_greylist_triplet ON greylist(client_ip, from_address, to_address);

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_domains_updated
    BEFORE UPDATE ON domains
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_mailboxes_updated
    BEFORE UPDATE ON mailboxes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_campaigns_updated
    BEFORE UPDATE ON campaigns
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_admin_users_updated
    BEFORE UPDATE ON admin_users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMIT;
