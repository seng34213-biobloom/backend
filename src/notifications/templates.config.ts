/**
 * SDS §4.2 transactional templates dispatched by NotificationsService. Each
 * entry produces `subject` + `html`; the `id` mirrors the SendGrid
 * dynamic-template id that production will substitute and is sent as the
 * `X-Biobloom-Template` header. Local dev renders the inline HTML body via
 * MailerService → MailHog.
 *
 * Templates are English only: the storefront's Sinhala locale covers the UI,
 * and transactional email stays in one language until the customer record
 * carries a locale preference.
 */

export type TemplateKey =
  | 'ORDER_CONFIRMED'
  | 'ORDER_SHIPPED'
  | 'ORDER_DELIVERED'
  | 'SUBSCRIPTION_RENEWED'
  | 'SUBSCRIPTION_CANCELLED'
  | 'SUBSCRIPTION_STOCK_DELAYED'
  | 'SUBSCRIPTION_CHARGE_FAILED'
  | 'BATCH_EXPIRING_SOON'
  | 'REFUND_ISSUED'
  | 'SELLER_APPROVED';

export interface RenderedMessage {
  subject: string;
  html: string;
}

/** Escapes untrusted values before they are placed in email HTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

/**
 * Customer-facing order reference: `BB-000123` once orders carry a number,
 * otherwise the first 8 characters of the order id.
 */
export function formatOrderReference(orderNumber: unknown, orderId?: unknown): string {
  if (orderNumber !== null && orderNumber !== undefined && orderNumber !== '') {
    return `BB-${String(orderNumber).padStart(6, '0')}`;
  }
  if (orderId) return `#${String(orderId).slice(0, 8)}`;
  return 'your order';
}

/** Subject lines are plain text: strip line breaks so they cannot inject headers. */
const plain = (value: unknown): string => String(value ?? '').replace(/[\r\n\t]+/g, ' ');

const wrap = (heading: string, body: string): string => `
<!doctype html>
<html><body style="font-family: system-ui, sans-serif; color: #2f4a2a; max-width: 600px; margin: 24px auto;">
  <h1 style="font-family: Georgia, serif; color: #557f41;">${heading}</h1>
  ${body}
  <hr style="margin-top: 32px; border: 0; border-top: 1px solid #e5ddc8;" />
  <p style="font-size: 12px; color: #94785a;">Bio Bloom · biobloom.lk</p>
</body></html>`;

const link = (href: unknown, label: string): string =>
  href ? `<p><a href="${escapeHtml(href)}">${label} →</a></p>` : '';

const orderRef = (d: Record<string, unknown>): string =>
  escapeHtml(formatOrderReference(d.orderNumber, d.orderId));

export const TEMPLATES: Record<
  TemplateKey,
  { id: string; render: (data: Record<string, unknown>) => RenderedMessage }
> = {
  ORDER_CONFIRMED: {
    id: 'd-order-confirmed',
    render: (d) => ({
      subject: `Order ${plain(formatOrderReference(d.orderNumber, d.orderId))} confirmed`,
      html: wrap(
        'Thanks for your order!',
        `<p>Order <strong>${orderRef(d)}</strong> is confirmed. We're packing your order now.</p>
         <p>Total: <strong>${escapeHtml(d.currency)} ${escapeHtml(d.totalAmount)}</strong></p>
         ${link(d.orderUrl, 'Track your order')}`,
      ),
    }),
  },
  ORDER_SHIPPED: {
    id: 'd-order-shipped',
    render: (d) => ({
      subject: `Order ${plain(formatOrderReference(d.orderNumber, d.orderId))} has shipped`,
      html: wrap(
        'On its way',
        `<p>Order <strong>${orderRef(d)}</strong> has left our kitchen and is on the road.</p>
         ${link(d.orderUrl, 'Track your order')}`,
      ),
    }),
  },
  ORDER_DELIVERED: {
    id: 'd-order-delivered',
    render: (d) => ({
      subject: `Order ${plain(formatOrderReference(d.orderNumber, d.orderId))} delivered — how was it?`,
      html: wrap(
        'Delivered!',
        `<p>Order <strong>${orderRef(d)}</strong> arrived. We hope you love it.</p>
         ${link(d.orderUrl, 'Leave a review')}`,
      ),
    }),
  },
  SUBSCRIPTION_RENEWED: {
    id: 'd-subscription-renewed',
    render: (d) => ({
      subject: 'Your Subscribe & Save renewed',
      html: wrap(
        'Your subscription renewed',
        `<p>We charged <strong>${escapeHtml(d.currency)} ${escapeHtml(d.amount)}</strong> for your subscription and packed your next jar.</p>
         <p>Order: <strong>${orderRef(d)}</strong></p>
         <p>Didn't expect this charge? Contact us straight away.</p>
         ${link(d.manageUrl, 'Manage your subscriptions')}`,
      ),
    }),
  },
  SUBSCRIPTION_CANCELLED: {
    id: 'd-subscription-cancelled',
    render: (d) => ({
      subject: 'Subscription cancelled',
      html: wrap(
        'Cancelled',
        `<p>Your subscription${d.productName ? ` to <strong>${escapeHtml(d.productName)}</strong>` : ''} has been cancelled. No more charges will happen.</p>
         <p>Change your mind? You can start a new one anytime.</p>`,
      ),
    }),
  },
  SUBSCRIPTION_STOCK_DELAYED: {
    id: 'd-subscription-stock-delayed',
    render: (d) => ({
      subject: 'Your Subscribe & Save delivery is delayed',
      html: wrap(
        'Stock delayed',
        `<p>We couldn't fill this cycle of your subscription${d.productName ? ` to <strong>${escapeHtml(d.productName)}</strong>` : ''}: we have ${escapeHtml(d.available)} of the ${escapeHtml(d.requested)} jar(s) you need in stock.</p>
         <p><strong>You have not been charged.</strong> We'll try again on your next billing date${d.nextBillingDate ? ` (<strong>${escapeHtml(d.nextBillingDate)}</strong>)` : ''}.</p>
         ${link(d.manageUrl, 'Manage your subscriptions')}`,
      ),
    }),
  },
  SUBSCRIPTION_CHARGE_FAILED: {
    id: 'd-subscription-charge-failed',
    render: (d) => ({
      subject: 'We could not charge your Subscribe & Save',
      html: wrap(
        'Payment declined',
        `<p>The automatic charge for your subscription${d.productName ? ` to <strong>${escapeHtml(d.productName)}</strong>` : ''} was declined${d.reason ? `: ${escapeHtml(d.reason)}` : ''}.</p>
         <p>No order was placed this cycle. Please update your payment method before your next billing date${d.nextBillingDate ? ` (<strong>${escapeHtml(d.nextBillingDate)}</strong>)` : ''}.</p>
         ${link(d.manageUrl, 'Update your payment method')}`,
      ),
    }),
  },
  BATCH_EXPIRING_SOON: {
    id: 'd-batch-expiring-soon',
    render: (d) => ({
      subject: `Batch ${plain(d.batchNumber)} expires soon`,
      html: wrap(
        'Batch expiring soon',
        `<p>Batch <strong>${escapeHtml(d.batchNumber)}</strong> on variant <code>${escapeHtml(d.productVariantId)}</code> expires in ${escapeHtml(d.daysUntilExpiry)} day(s).</p>
         <p>Remaining quantity: ${escapeHtml(d.currentQuantity)}</p>
         <p>Mark it down or rotate it before it expires.</p>`,
      ),
    }),
  },
  REFUND_ISSUED: {
    id: 'd-refund-issued',
    render: (d) => ({
      subject: 'Your refund is on the way',
      html: wrap(
        'Refund processed',
        `<p>${escapeHtml(d.currency ?? 'LKR')} ${escapeHtml(d.amount)} has been refunded for order <strong>${orderRef(d)}</strong>.</p>
         <p>It usually takes 3–5 business days to land back on your card.</p>`,
      ),
    }),
  },
  SELLER_APPROVED: {
    id: 'd-seller-approved',
    render: (d) => ({
      subject: 'You’re approved — welcome to Bio Bloom',
      html: wrap(
        `Welcome, ${escapeHtml(d.businessName ?? 'seller')}!`,
        `<p>Your seller account has been approved. You can now add products and batches.</p>
         ${link(d.portalUrl, 'Open your seller dashboard')}`,
      ),
    }),
  },
};
