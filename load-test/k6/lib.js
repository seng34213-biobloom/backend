import http from 'k6/http';
import { fail } from 'k6';

export const API_BASE = __ENV.API_BASE || 'http://localhost:4000';

/**
 * Signs in through the real flow (the CSRF double-submit cookie, then
 * login). k6 keeps the cookies per virtual user; the returned params carry
 * the CSRF header for later state-changing requests.
 */
export function signIn(email, password) {
  const csrfRes = http.get(`${API_BASE}/api/auth/csrf`, { tags: { stage: 'login' } });
  const csrf = csrfRes.json('csrfToken');
  if (!csrf) fail(`could not get a CSRF token: ${csrfRes.status}`);

  const params = { headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf } };
  const login = http.post(`${API_BASE}/api/auth/login`, JSON.stringify({ email, password }), {
    ...params,
    tags: { stage: 'login' },
  });
  if (login.status !== 200) fail(`login returned ${login.status} for ${email}`);
  return params;
}
