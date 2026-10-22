/**
 * SDS §4.2 transactional templates dispatched by NotificationsService. Each
 * entry produces `subject` + `html`; the `id` mirrors the SendGrid
 * dynamic-template id that production will substitute. Local dev renders the
 * inline HTML body via MailerService → MailHog.
 */

export type TemplateKey = 'BATCH_EXPIRING_SOON';

export interface RenderedMessage {
  subject: string;
  html: string;
}

const wrap = (heading: string, body: string): string => `
<!doctype html>
<html><body style="font-family: system-ui, sans-serif; color: #2f4a2a; max-width: 600px; margin: 24px auto;">
  <h1 style="font-family: Georgia, serif; color: #557f41;">${heading}</h1>
  ${body}
  <hr style="margin-top: 32px; border: 0; border-top: 1px solid #e5ddc8;" />
  <p style="font-size: 12px; color: #94785a;">Bio Bloom · biobloom.lk</p>
</body></html>`;

export const TEMPLATES: Record<
  TemplateKey,
  { id: string; render: (data: Record<string, unknown>) => RenderedMessage }
> = {
  BATCH_EXPIRING_SOON: {
    id: 'd-batch-expiring-soon',
    render: (d) => ({
      subject: `Batch ${d.batchNumber as string} expires soon`,
      html: wrap(
        'Batch expiring soon',
        `<p>Batch <strong>${d.batchNumber}</strong> on variant <code>${d.productVariantId}</code> expires in ${d.daysUntilExpiry} day(s).</p>
         <p>Remaining quantity: ${d.currentQuantity}</p>
         <p>Mark it down or rotate it before it expires.</p>`,
      ),
    }),
  },
};
