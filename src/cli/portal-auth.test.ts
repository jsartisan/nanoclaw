import type http from 'http';

import { describe, expect, it } from 'vitest';

import { checkPortalAuth } from './portal-auth.js';

function req(headers: Record<string, string>): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

function url(params = ''): URL {
  return new URL(`http://127.0.0.1:4100/api/call${params}`);
}

describe('portal auth', () => {
  it('accepts a request with a local Host and no Origin', () => {
    const auth = checkPortalAuth(req({ host: '127.0.0.1:4100' }), url());
    expect(auth.result).toBe('ok');
    if (auth.result === 'ok') {
      expect(auth.ctx).toEqual({ caller: 'portal' });
    }
  });

  it('accepts local Origins (same-origin portal + Vite dev server)', () => {
    for (const origin of ['http://127.0.0.1:4100', 'http://localhost:4101', 'http://[::1]:4100']) {
      const r = req({ host: '127.0.0.1:4100', origin });
      expect(checkPortalAuth(r, url()).result).toBe('ok');
    }
  });

  it('rejects a non-local Origin (browser-origin CSRF)', () => {
    const r = req({ host: '127.0.0.1:4100', origin: 'https://evil.example' });
    expect(checkPortalAuth(r, url()).result).toBe('bad-origin');
  });

  it('rejects a non-local Host (DNS rebinding)', () => {
    const r = req({ host: 'evil.example:4100' });
    expect(checkPortalAuth(r, url()).result).toBe('bad-origin');
  });

  it('rejects an unparseable Origin', () => {
    const r = req({ host: '127.0.0.1:4100', origin: 'not a url::' });
    expect(checkPortalAuth(r, url()).result).toBe('bad-origin');
  });
});
