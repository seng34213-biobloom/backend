import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { renderOrderConfirmed } from './templates.config';

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
      secure: port === 465,
      ...(user && pass ? { auth: { user, pass } } : {}),
      ignoreTLS: port === 1025,
    });
  }

  async sendOrderConfirmed(input: {
    to: string;
    orderId: string;
    totalAmount: string;
    currency: string;
  }): Promise<void> {
    const message = renderOrderConfirmed(input);
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: input.to,
        subject: message.subject,
        html: message.html,
        headers: { 'X-Biobloom-Template': 'd-order-confirmed' },
      });
      this.logger.log(`Order confirmation email sent for order=${input.orderId}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown SMTP error';
      this.logger.error(`Order confirmation email failed for order=${input.orderId}: ${detail}`);
    }
  }
}
