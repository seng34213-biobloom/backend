import { TEMPLATES, escapeHtml } from './templates.config';

describe('templates', () => {
  it('escapes untrusted order data in the order confirmed email', () => {
    const rendered = TEMPLATES.ORDER_CONFIRMED.render({
      orderId: '<script>bad</script>',
      totalAmount: '1&2',
      currency: 'LKR',
    });

    expect(rendered.html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(rendered.html).toContain('1&amp;2');
    expect(rendered.html).not.toContain('<script>');
  });

  it('escapes every HTML special character', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});
