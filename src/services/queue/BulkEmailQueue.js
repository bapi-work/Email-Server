'use strict';

const Bull = require('bull');
const nodemailer = require('nodemailer');
const config = require('../../config');
const db = require('../../database/connection');
const logger = require('../../utils/logger');
const DkimService = require('../dkim/DkimService');

class BulkEmailQueue {
  constructor() {
    const redisConfig = config.redis.url
      ? config.redis.url
      : {
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
        };

    this.queue = new Bull('bulk-email', { redis: redisConfig });
    this._setupProcessor();
    this._setupEventHandlers();
  }

  _setupProcessor() {
    this.queue.process(config.bulk.concurrency, async (job) => {
      const { campaignId, recipientId, to, name, subject, bodyHtml, bodyText,
              fromAddress, fromName, replyTo, variables } = job.data;

      try {
        // Apply variable substitution
        const finalSubject = this._applyVars(subject, name, variables);
        const finalHtml = this._applyVars(bodyHtml || '', name, variables);
        const finalText = this._applyVars(bodyText || '', name, variables);

        const fromDomain = fromAddress.split('@')[1];

        // Build transport
        const transportConfig = config.relay.host
          ? {
              host: config.relay.host,
              port: config.relay.port,
              secure: config.relay.port === 465,
              auth: config.relay.user ? { user: config.relay.user, pass: config.relay.pass } : undefined,
            }
          : { direct: true, name: fromDomain };

        const transport = nodemailer.createTransport(transportConfig);

        // Apply DKIM signing
        const keyInfo = await DkimService.getPrivateKey(fromDomain);
        if (keyInfo) {
          transport.options.dkim = {
            domainName: fromDomain,
            keySelector: keyInfo.selector,
            privateKey: keyInfo.privateKey,
          };
        }

        const info = await transport.sendMail({
          from: fromName ? `"${fromName}" <${fromAddress}>` : fromAddress,
          to: name ? `"${name}" <${to}>` : to,
          replyTo: replyTo || undefined,
          subject: finalSubject,
          html: finalHtml || undefined,
          text: finalText || undefined,
          headers: {
            'X-Campaign-ID': campaignId,
            'X-Mailer': `${config.app.name}/1.0`,
            'List-Unsubscribe': `<mailto:unsubscribe@${fromDomain}?subject=unsubscribe>`,
          },
        });

        // Update recipient status
        await db.query(
          `UPDATE campaign_recipients
           SET status = 'sent', message_id = $1, sent_at = NOW()
           WHERE id = $2`,
          [info.messageId, recipientId]
        );

        // Increment campaign sent count
        await db.query(
          'UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = $1',
          [campaignId]
        );

        logger.debug('Bulk email sent', { to, campaignId, messageId: info.messageId });
        return { success: true, messageId: info.messageId };

      } catch (err) {
        logger.error('Bulk email failed', { to, campaignId, error: err.message });

        await db.query(
          `UPDATE campaign_recipients SET status = 'failed', error = $1 WHERE id = $2`,
          [err.message, recipientId]
        );
        await db.query(
          'UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = $1',
          [campaignId]
        );

        throw err; // Let Bull handle retry
      }
    });
  }

  _setupEventHandlers() {
    this.queue.on('completed', (job) => {
      logger.debug('Queue job completed', { id: job.id });
    });

    this.queue.on('failed', (job, err) => {
      logger.warn('Queue job failed', { id: job.id, error: err.message });
    });

    this.queue.on('error', (err) => {
      logger.error('Queue error', { error: err.message });
    });

    this.queue.on('stalled', (job) => {
      logger.warn('Queue job stalled', { id: job.id });
    });
  }

  /**
   * Enqueue all recipients for a campaign
   */
  async enqueueCampaign(campaignId) {
    const campaign = await db.query(
      'SELECT * FROM campaigns WHERE id = $1',
      [campaignId]
    );
    if (!campaign.rows.length) throw new Error('Campaign not found');
    const c = campaign.rows[0];

    if (!['draft', 'scheduled'].includes(c.status)) {
      throw new Error(`Campaign cannot be started in status: ${c.status}`);
    }

    // Update status
    await db.query(
      "UPDATE campaigns SET status = 'sending', started_at = NOW() WHERE id = $1",
      [campaignId]
    );

    // Get pending recipients
    const recipients = await db.query(
      "SELECT * FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'",
      [campaignId]
    );

    logger.info('Enqueueing campaign', { campaignId, recipients: recipients.rows.length });

    const jobs = recipients.rows.map(r => ({
      data: {
        campaignId,
        recipientId: r.id,
        to: r.email,
        name: r.name,
        subject: c.subject,
        bodyHtml: c.body_html,
        bodyText: c.body_text,
        fromAddress: c.from_address,
        fromName: c.from_name,
        replyTo: c.reply_to,
        variables: r.variables || {},
      },
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        delay: config.bulk.delayMs,
      },
    }));

    // Batch add jobs
    const BATCH = 500;
    for (let i = 0; i < jobs.length; i += BATCH) {
      await this.queue.addBulk(jobs.slice(i, i + BATCH));
    }

    // Update recipient statuses
    await db.query(
      "UPDATE campaign_recipients SET status = 'queued' WHERE campaign_id = $1 AND status = 'pending'",
      [campaignId]
    );

    // Watch for completion
    this._watchCampaignCompletion(campaignId, recipients.rows.length);

    return recipients.rows.length;
  }

  _watchCampaignCompletion(campaignId, total) {
    const check = async () => {
      const result = await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('sent','delivered')) as done,
           COUNT(*) FILTER (WHERE status = 'failed') as failed,
           COUNT(*) FILTER (WHERE status IN ('pending','queued')) as pending
         FROM campaign_recipients WHERE campaign_id = $1`,
        [campaignId]
      );
      const r = result.rows[0];
      if (parseInt(r.pending) === 0) {
        await db.query(
          "UPDATE campaigns SET status = 'completed', completed_at = NOW() WHERE id = $1",
          [campaignId]
        );
        logger.info('Campaign completed', { campaignId, sent: r.done, failed: r.failed });
      } else {
        setTimeout(check, 10000);
      }
    };
    setTimeout(check, 10000);
  }

  /**
   * Pause a campaign
   */
  async pauseCampaign(campaignId) {
    await this.queue.pause();
    await db.query(
      "UPDATE campaigns SET status = 'paused' WHERE id = $1",
      [campaignId]
    );
  }

  /**
   * Resume a paused campaign
   */
  async resumeCampaign(campaignId) {
    await this.queue.resume();
    await db.query(
      "UPDATE campaigns SET status = 'sending' WHERE id = $1",
      [campaignId]
    );
  }

  /**
   * Get queue stats
   */
  async getStats() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);
    return { waiting, active, completed, failed, delayed };
  }

  _applyVars(template, name, variables = {}) {
    let result = template;
    result = result.replace(/\{\{name\}\}/gi, name || '');
    result = result.replace(/\{\{first_name\}\}/gi, (name || '').split(' ')[0] || '');
    for (const [key, value] of Object.entries(variables)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'gi'), value);
    }
    return result;
  }

  async addJob(data) {
    return this.queue.add(data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }

  start() {
    logger.info('Bulk email queue worker ready');
  }

  stop() {
    return this.queue.close();
  }

  async close() {
    await this.queue.close();
  }
}

// Singleton
let _instance = null;

BulkEmailQueue.getInstance = function () {
  if (!_instance) _instance = new BulkEmailQueue();
  return _instance;
};

module.exports = BulkEmailQueue;
