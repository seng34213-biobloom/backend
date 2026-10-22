import { renderOrderConfirmed } from './templates.config';

describe('renderOrderConfirmed', () => {
  it('escapes untrusted order data in the email body', () => {
    const rendered = renderOrderConfirmed({
      orderId: '<script>bad</script>',
      totalAmount: '1&2',
      currency: 'LKR',
    });

    expect(rendered.html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(rendered.html).toContain('1&amp;2');
    expect(rendered.html).not.toContain('<script>');
  });
});
