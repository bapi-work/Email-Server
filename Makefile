.PHONY: help up down build logs migrate seed shell psql redis-cli clean ssl-self

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

up: ## Start all services
	docker compose up -d
	@echo "CloudMail is starting..."
	@echo "  Webmail:  http://localhost/webmail"
	@echo "  Admin:    http://localhost/admin"
	@echo "  API:      http://localhost/api/health"

down: ## Stop all services
	docker compose down

build: ## Rebuild the mail server image
	docker compose build --no-cache mailserver

logs: ## Follow mailserver logs
	docker compose logs -f mailserver

logs-all: ## Follow all service logs
	docker compose logs -f

migrate: ## Run database migrations
	docker compose exec mailserver node src/database/migrate.js

seed: ## Seed initial admin user
	docker compose exec mailserver node src/database/migrate.js

shell: ## Open shell in mailserver container
	docker compose exec mailserver sh

psql: ## Open PostgreSQL shell
	docker compose exec postgres psql -U $${DB_USER:-cloudmail} -d $${DB_NAME:-cloudmail}

redis-cli: ## Open Redis CLI
	docker compose exec redis redis-cli

restart: ## Restart mailserver
	docker compose restart mailserver

ssl-self: ## Generate self-signed SSL certificate (dev only)
	@mkdir -p ssl
	openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
		-keyout ssl/mail.key \
		-out ssl/mail.crt \
		-subj "/C=US/ST=State/L=City/O=CloudMail/CN=localhost"
	@echo "Self-signed certificate created in ./ssl/"

ssl-certbot: ## Get Let's Encrypt certificate (requires DOMAIN and EMAIL env vars)
	@test -n "$(DOMAIN)" || (echo "Set DOMAIN=yourdomain.com"; exit 1)
	@test -n "$(EMAIL)"  || (echo "Set EMAIL=admin@yourdomain.com"; exit 1)
	certbot certonly --standalone -d $(DOMAIN) -d mail.$(DOMAIN) --email $(EMAIL) --agree-tos --non-interactive
	cp /etc/letsencrypt/live/$(DOMAIN)/fullchain.pem ssl/mail.crt
	cp /etc/letsencrypt/live/$(DOMAIN)/privkey.pem ssl/mail.key

dkim-generate: ## Generate DKIM key for a domain (DOMAIN=example.com)
	@test -n "$(DOMAIN)" || (echo "Set DOMAIN=yourdomain.com"; exit 1)
	docker compose exec mailserver node -e " \
		const DkimService = require('./src/services/dkim/DkimService'); \
		const kp = DkimService.generateKeyPair(2048); \
		console.log('Private key saved to DB'); \
		console.log('DNS TXT record:'); \
		console.log('Host: mail._domainkey.$(DOMAIN)'); \
		console.log('Value: v=DKIM1; k=rsa; p=' + kp.publicKeyDns); \
	"

clean: ## Remove all volumes (DESTRUCTIVE)
	@echo "WARNING: This will delete ALL mail data. Press Ctrl+C to cancel."
	@sleep 5
	docker compose down -v

status: ## Show service status
	docker compose ps

ps: status
