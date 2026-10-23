import { TEMPLATES, escapeHtml, formatOrderReference, type TemplateKey } from './templates.config';

const XSS = '<script>alert(1)</script>';

describe('templates', () => {
  it('escapes untrusted order data in the order confirmed email', () => {
    const rendered = TEMPLATES.ORDER_CONFIRMED.render({
      orderId: '<script>bad</script>',
      totalAmount: '1&2',
      currency: 'LKR',
    });

    expect(rendered.html).toContain('&lt;script');
    expect(rendered.html).toContain('1&amp;2');
    expect(rendered.html).not.toContain('<script>');
  });

  it('escapes every HTML special character', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
    expect(escapeHtml(null)).toBe('');
  });

  it.each<[TemplateKey, Record<string, unknown>]>([
    ['ORDER_CONFIRMED', { orderId: 'o-1', totalAmount: XSS, currency: XSS, orderUrl: XSS }],
    ['ORDER_SHIPPED', { orderId: 'o-1', orderUrl: XSS }],
    ['ORDER_DELIVERED', { orderId: 'o-1', orderUrl: XSS }],
    ['SUBSCRIPTION_RENEWED', { orderId: 'o-1', amount: XSS, currency: XSS, manageUrl: XSS }],
    ['SUBSCRIPTION_CANCELLED', { productName: XSS }],
    ['BATCH_EXPIRING_SOON', { batchNumber: XSS, productVariantId: XSS, currentQuantity: XSS }],
    ['REFUND_ISSUED', { orderId: 'o-1', amount: XSS, currency: XSS }],
    ['SELLER_APPROVED', { businessName: XSS, portalUrl: XSS }],
  ])('%s escapes every value placed in the HTML', (template, data) => {
    const rendered = TEMPLATES[template].render(data);

    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('keeps line breaks out of subject lines', () => {
    const rendered = TEMPLATES.BATCH_EXPIRING_SOON.render({ batchNumber: 'B-1\r\nBcc: x@y.z' });
    expect(rendered.subject).toBe('Batch B-1 Bcc: x@y.z expires soon');
  });

  it('formats the order reference from the order number, else the order id', () => {
    expect(formatOrderReference(123)).toBe('BB-000123');
    expect(formatOrderReference(undefined, '9f8e7d6c-1234-5678')).toBe('#9f8e7d6c');
    expect(formatOrderReference(null)).toBe('your order');
  });

  it('only renders links that have a URL', () => {
    expect(TEMPLATES.ORDER_SHIPPED.render({ orderId: 'o-1' }).html).not.toContain('<a ');
    expect(
      TEMPLATES.ORDER_SHIPPED.render({ orderId: 'o-1', orderUrl: 'https://biobloom.lk/o/1' }).html,
    ).toContain('<a href="https://biobloom.lk/o/1">Track your order →</a>');
  });
});
