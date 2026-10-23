import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { TEMPLATES, type RenderedMessage, type TemplateKey } from './templates.config';

export interface SendArgs {
  to: string;
  template: TemplateKey;
  data: Record<string, unknown>;
}

/**
 * SDS §4.2 NotificationService → mail dispatcher.
 *
 * Dev: SMTP transport pointing at MailHog (docker-compose, port 1025).
 * Prod: SMTP transport pointing at SendGrid's `smtp.sendgrid.net:465` (or
 *       swap in `@sendgrid/mail` HTTP API by replacing `_send`). Either
 *       way the call site doesn't change — handlers just call
 *       `mailer.send({to, template, data})`.
 *
 * Failures are logged but never thrown — the SDS asks for async delivery
 * that cannot block the request thread.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: ConfigService) {
    const host = config.get<string>('SMTP_HOST') ?? 'localhost';
    const port = Number(config.get<string>('SMTP_PORT') ?? '1025');
    const user = config.get<string>('SMTP_USER');
    const pass = config.get<string>('SMTP_PASS');
    this.from = config.get<string>('SMTP_FROM') ?? 'noreply@biobloom.local';
    this.transporter = createTransport({
      host,
      port,
      // MailHog speaks plain SMTP on 1025 (no TLS); SendGrid requires TLS on 465.
      secure: port === 465,
      ...(user && pass ? { auth: { user, pass } } : {}),
      // Don't crash on connect errors — we log + drop in dev.
      ignoreTLS: port === 1025,
    });
  }

  async send(args: SendArgs): Promise<{ accepted: boolean; templateId: string }> {
    const tpl = TEMPLATES[args.template];
    if (!tpl) {
      this.logger.error(`Unknown template ${args.template}`);
      return { accepted: false, templateId: '' };
    }
    const message: RenderedMessage = tpl.render(args.data);
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: args.to,
        subject: message.subject,
        html: message.html,
        headers: {
          'X-Biobloom-Template': tpl.id,
        },
      });
      this.logger.log(`Mail ${args.template} → ${args.to} (template ${tpl.id})`);
      return { accepted: true, templateId: tpl.id };
    } catch (e) {
      this.logger.error(`Mail ${args.template} → ${args.to} FAILED: ${(e as Error).message}`);
      return { accepted: false, templateId: tpl.id };
    }
  }
}
