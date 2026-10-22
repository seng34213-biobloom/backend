export interface RenderedMessage {
  subject: string;
  html: string;
}

export function renderOrderConfirmed(data: {
  orderId: string;
  totalAmount: string;
  currency: string;
}): RenderedMessage {
  const orderId = escapeHtml(data.orderId);
  const currency = escapeHtml(data.currency);
  const amount = escapeHtml(data.totalAmount);
  return {
    subject: `Order ${data.orderId.slice(0, 8)} confirmed`,
    html: `<!doctype html>
<html><body style="font-family: system-ui, sans-serif; color: #2f4a2a; max-width: 600px; margin: 24px auto;">
  <h1 style="font-family: Georgia, serif; color: #557f41;">Thanks for your order!</h1>
  <p>Order <strong>${orderId}</strong> is confirmed. We're packing your order now.</p>
  <p>Total: <strong>${currency} ${amount}</strong></p>
  <hr style="margin-top: 32px; border: 0; border-top: 1px solid #e5ddc8;" />
  <p style="font-size: 12px; color: #94785a;">Bio Bloom · biobloom.lk</p>
</body></html>`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
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
