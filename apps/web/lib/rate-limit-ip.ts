/**
 * Cubo del rate limit para una IP. IPv4 tal cual; IPv6 agrupada por /64 (los
 * primeros 4 hextetos, con `::` expandido), porque un solo /64 residencial
 * da direcciones infinitas y contar por dirección exacta no limita nada.
 * `::ffff:a.b.c.d` (IPv4 mapeada) se trata como la IPv4.
 */
export function rateLimitBucketForIp(ip: string): string {
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];

  const [head, tail = ''] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const zeros = Math.max(0, 8 - headParts.length - tailParts.length);
  const full = [...headParts, ...Array<string>(zeros).fill('0'), ...tailParts];
  const prefix = full
    .slice(0, 4)
    .map((h) => (h || '0').toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':');
  return `${prefix}::/64`;
}
