/** Verify that the public login path can accept a burst before starting VUs. */
import http from 'k6/http';
import { Counter, Rate } from 'k6/metrics';

const baseUrl = String(__ENV.BASE_URL || '').replace(/\/+$/, '');
if (!baseUrl) throw new Error('BASE_URL is required for the login ingress preflight');

const expectedBadRequest = http.expectedStatuses(400);
const probeSuccess = new Rate('login_ingress_probe_success');
const probeCount = new Counter('login_ingress_probe_count');
const probeTotal = 12;

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    login_ingress_probe_success: ['rate==1'],
    login_ingress_probe_count: [`count==${probeTotal}`],
  },
};

export default function () {
  for (let index = 0; index < probeTotal; index += 1) {
    // Empty JSON fails route validation before looking up an account. Each
    // request still traverses the same edge and API login rate-limit rules.
    const response = http.post(`${baseUrl}/api/v1/auth/login`, '{}', {
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      responseCallback: expectedBadRequest,
      timeout: '5s',
      redirects: 0,
      tags: { name: 'login_ingress_probe' },
    });
    const okay = response.status === 400;
    probeSuccess.add(okay);
    probeCount.add(1);
    if (!okay) {
      const server = response.headers?.Server || response.headers?.server || 'unknown';
      const contentType = response.headers?.['Content-Type'] || response.headers?.['content-type'] || 'unknown';
      console.error(`Login ingress probe ${index + 1}/${probeTotal} returned ${response.status}; server=${server}; content-type=${contentType}; error-code=${response.error_code || 'none'}`);
      return;
    }
  }
}
