// Sign-in start-up and a connect coming back from Zernio (ad accounts): ?error=… with Zernio's error_reason (or our
// ylb_connect) is the connect's, not a Supabase link error. Start-up leaves it in the address for the connect-return
// watcher, and a signed-out visitor isn't shown Zernio's raw error as a sign-in error. A real Supabase link error is
// still read, and only its own keys leave the address.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      // signed out: the first session event says so
      onAuthStateChange: (cb: (event: string, session: null) => void) => {
        setTimeout(() => cb('INITIAL_SESSION', null), 0);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      getSession: async () => ({ data: { session: null } }),
      signOut: async () => ({ error: null }),
    },
  }),
}));

const { linkError, startAuth, useAuth } = await import('./auth');
const { parseConnectReturn } = await import('@/lib/integrations/connectReturn');

const ZERNIO_ERROR = '?ylb_connect=meta_ads&error=access_denied&platform=metaads&error_reason=ad_accounts_not_granted&error_message=Nope&is_user_fixable=true';

describe('start-up with a Zernio error return in the address', () => {
  const replaceState = vi.fn();
  beforeAll(async () => {
    vi.stubGlobal('location', { protocol: 'http:', origin: 'http://app.test', pathname: '/', search: ZERNIO_ERROR, hash: '', href: `http://app.test/${ZERNIO_ERROR}`, reload: vi.fn() });
    vi.stubGlobal('history', { replaceState, state: null });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ accounts: { enabled: true, url: 'https://db.example', publishableKey: 'pk_test', signInRequired: true, canDeleteAccount: false } }), { status: 200 })));
    await startAuth();
    await vi.waitFor(() => expect(useAuth.getState().phase).toBe('signed-out'));
  });
  afterAll(() => vi.unstubAllGlobals());

  it('leaves the connect’s parameters for the watcher, and shows no sign-in error', () => {
    expect(replaceState).not.toHaveBeenCalled();
    expect(useAuth.getState().notice).toBeNull();
    expect(parseConnectReturn(location.search)).toEqual({ kind: 'error', platform: 'meta_ads', reason: 'ad_accounts_not_granted', userFixable: true });
  });
});

describe('linkError', () => {
  const hist = () => ({ replaceState: vi.fn(), state: { keep: 1 } });

  it('reads a Supabase link error and takes only its keys out of the address', () => {
    const h = hist();
    const msg = linkError({ pathname: '/', search: '?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&billing=success', hash: '#dashboard' }, h);
    expect(msg).toBe('That link has expired or was already used. Sign in, or ask for a new link.');
    expect(h.replaceState).toHaveBeenCalledWith({ keep: 1 }, '', '/?billing=success#dashboard');
  });

  it('an error in the hash (the implicit flow): the hash goes, the query stays', () => {
    const h = hist();
    expect(linkError({ pathname: '/', search: '?ref=mail', hash: '#error=server_error&error_description=Something+broke' }, h)).toBe('Something broke');
    expect(h.replaceState).toHaveBeenCalledWith({ keep: 1 }, '', '/?ref=mail');
  });

  it('a Zernio return (ours, or its error parameters) is not a link error: nothing is read or removed', () => {
    for (const search of [ZERNIO_ERROR, '?error=access_denied&error_reason=state_expired&platform=googleads', '?ylb_connect=google_ads&connected=googleads&accountId=0123456789abcdef01234567']) {
      const h = hist();
      expect(linkError({ pathname: '/', search, hash: '' }, h)).toBeNull();
      expect(h.replaceState).not.toHaveBeenCalled();
    }
  });
});
