import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../html-escape';

describe('escapeHtml', () => {
  it('neutraliza los cinco caracteres que cambian de significado en HTML', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;',
    );
  });

  it('deja pasar texto normal sin tocarlo', () => {
    expect(escapeHtml('acme.myshopify.com')).toBe('acme.myshopify.com');
    expect(escapeHtml('')).toBe('');
  });
});
