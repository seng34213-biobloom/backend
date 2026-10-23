import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { TEMPLATES } from './templates.config';

// Capture the args nodemailer.sendMail receives across all transports.
const sendMailMock = jest.fn().mockResolvedValue({ messageId: 'mock-1' });
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: sendMailMock })),
}));

// Importing after the mock so MailerService's createTransport call wires to the stub.
import { MailerService } from './mailer.service';

const configWith = (values: Record<string, string>) =>
  ({ get: jest.fn((k: string) => values[k]) }) as unknown as ConfigService;

describe('MailerService', () => {
  let svc: MailerService;

  beforeEach(() => {
    sendMailMock.mockClear();
    (createTransport as jest.Mock).mockClear();
    svc = new MailerService(
      configWith({
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        SMTP_FROM: 'noreply@biobloom.local',
      }),
    );
  });

  it('renders + sends with X-Biobloom-Template header', async () => {
    const out = await svc.send({
      to: 'admin@biobloom.lk',
      template: 'BATCH_EXPIRING_SOON',
      data: { batchNumber: 'B-1', productVariantId: 'v-1', currentQuantity: 5, daysUntilExpiry: 3 },
    });
    expect(out).toEqual({ accepted: true, templateId: TEMPLATES.BATCH_EXPIRING_SOON.id });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const args = sendMailMock.mock.calls[0][0];
    expect(args.to).toBe('admin@biobloom.lk');
    expect(args.from).toBe('noreply@biobloom.local');
    expect(args.subject).toBe('Batch B-1 expires soon');
    expect(args.html).toContain('expires in 3 day(s)');
    expect(args.html).toContain('Remaining quantity: 5');
    expect(args.headers['X-Biobloom-Template']).toBe(TEMPLATES.BATCH_EXPIRING_SOON.id);
  });

  it('catches dispatch failures and returns accepted=false (never throws)', async () => {
    sendMailMock.mockRejectedValueOnce(new Error('SMTP unreachable'));
    const out = await svc.send({
      to: 'admin@biobloom.lk',
      template: 'BATCH_EXPIRING_SOON',
      data: { batchNumber: 'B-1' },
    });
    expect(out).toEqual({ accepted: false, templateId: TEMPLATES.BATCH_EXPIRING_SOON.id });
  });

  it.each(Object.keys(TEMPLATES) as Array<keyof typeof TEMPLATES>)(
    'sends %s with its template header',
    async (template) => {
      const out = await svc.send({ to: 'a@b.com', template, data: { orderId: 'o-1' } });

      expect(out).toEqual({ accepted: true, templateId: TEMPLATES[template].id });
      const args = sendMailMock.mock.calls[0][0];
      expect(args.subject).toBeTruthy();
      expect(args.html).toBeTruthy();
      expect(args.headers['X-Biobloom-Template']).toBe(TEMPLATES[template].id);
    },
  );

  it('returns accepted=false without sending when a template fails to render', async () => {
    const spy = jest.spyOn(TEMPLATES.ORDER_SHIPPED, 'render').mockImplementation(() => {
      throw new Error('bad data');
    });

    const out = await svc.send({ to: 'a@b.com', template: 'ORDER_SHIPPED', data: {} });

    expect(out).toEqual({ accepted: false, templateId: TEMPLATES.ORDER_SHIPPED.id });
    expect(sendMailMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns accepted=false for an unknown template without sending', async () => {
    const out = await svc.send({
      to: 'admin@biobloom.lk',
      template: 'NOT_A_TEMPLATE' as never,
      data: {},
    });
    expect(out).toEqual({ accepted: false, templateId: '' });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('uses plain SMTP for MailHog and TLS with auth for SendGrid', () => {
    expect((createTransport as jest.Mock).mock.calls[0][0]).toMatchObject({
      host: 'localhost',
      port: 1025,
      secure: false,
      ignoreTLS: true,
    });

    new MailerService(
      configWith({
        SMTP_HOST: 'smtp.sendgrid.net',
        SMTP_PORT: '465',
        SMTP_USER: 'apikey',
        SMTP_PASS: 'not-a-real-key',
      }),
    );
    expect((createTransport as jest.Mock).mock.calls[1][0]).toMatchObject({
      host: 'smtp.sendgrid.net',
      port: 465,
      secure: true,
      ignoreTLS: false,
      auth: { user: 'apikey', pass: 'not-a-real-key' },
    });
  });

  it('falls back to MailHog defaults when SMTP is not configured', () => {
    new MailerService(configWith({}));
    expect((createTransport as jest.Mock).mock.calls[1][0]).toMatchObject({
      host: 'localhost',
      port: 1025,
    });
  });
});
