import { resolveClientIp } from './client-ip.util';

describe('resolveClientIp', () => {
  const SECRET = 's'.repeat(64);
  const request = (headers: Record<string, string>, ip = '10.0.0.1') => ({
    headers,
    ip,
  });

  it('should use X-Visitor-IP when relayed with the right secret', () => {
    expect(
      resolveClientIp(
        request({
          'x-web-proxy-secret': SECRET,
          'x-visitor-ip': '196.200.1.2',
        }),
        SECRET,
      ),
    ).toBe('196.200.1.2');
  });

  it('should accept IPv6 visitor addresses', () => {
    expect(
      resolveClientIp(
        request({
          'x-web-proxy-secret': SECRET,
          'x-visitor-ip': '2001:db8::1',
        }),
        SECRET,
      ),
    ).toBe('2001:db8::1');
  });

  it('should ignore X-Visitor-IP without the right secret (spoofing)', () => {
    expect(
      resolveClientIp(
        request({ 'x-web-proxy-secret': 'wrong', 'x-visitor-ip': '1.1.1.1' }),
        SECRET,
      ),
    ).toBe('10.0.0.1');
    expect(
      resolveClientIp(request({ 'x-visitor-ip': '1.1.1.1' }), SECRET),
    ).toBe('10.0.0.1');
  });

  it('should ignore a relayed value that is not an IP', () => {
    expect(
      resolveClientIp(
        request({
          'x-web-proxy-secret': SECRET,
          'x-visitor-ip': '1.1.1.1, 2.2.2.2',
        }),
        SECRET,
      ),
    ).toBe('10.0.0.1');
  });

  it('should always use req.ip when WEB_PROXY_SECRET is not configured', () => {
    expect(
      resolveClientIp(
        request({ 'x-web-proxy-secret': '', 'x-visitor-ip': '1.1.1.1' }),
        undefined,
      ),
    ).toBe('10.0.0.1');
  });
});
