import { ThrottlerGuard } from '@nestjs/throttler';
import { UserThrottlerGuard } from './user-throttler.guard';

class TestableUserThrottlerGuard extends UserThrottlerGuard {
  track(request: Parameters<ThrottlerGuard['getTracker']>[0]) {
    return this.getTracker(request);
  }
}

describe('UserThrottlerGuard', () => {
  const guard = Object.create(TestableUserThrottlerGuard.prototype) as TestableUserThrottlerGuard;

  it('tracks authenticated requests by user ID rather than IP', async () => {
    await expect(guard.track({ user: { id: 'customer-1' }, ip: '192.0.2.10' })).resolves.toBe(
      'customer-1',
    );
    await expect(guard.track({ user: { id: 'customer-1' }, ip: '198.51.100.25' })).resolves.toBe(
      'customer-1',
    );
  });

  it('does not trust forwarded IP headers for unauthenticated requests', async () => {
    await expect(guard.track({ ips: ['198.51.100.20'], ip: '127.0.0.1' })).resolves.toBe(
      '127.0.0.1',
    );
  });

  it('falls back to the request IP when no forwarded IP exists', async () => {
    await expect(guard.track({ ip: '192.0.2.25' })).resolves.toBe('192.0.2.25');
  });

  it('uses a stable fallback when the request has no identity or address', async () => {
    await expect(guard.track({})).resolves.toBe('unknown');
  });
});
