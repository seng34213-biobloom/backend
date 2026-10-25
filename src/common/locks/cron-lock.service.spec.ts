import { RedisService } from '../../redis/redis.service';
import { CronLockService } from './cron-lock.service';

describe('CronLockService', () => {
  let set: jest.Mock;
  let locks: CronLockService;

  beforeEach(() => {
    set = jest.fn().mockResolvedValue('OK');
    locks = new CronLockService({ getClient: () => ({ set }) } as unknown as RedisService);
  });

  it('runs the job when it takes the lock', async () => {
    const job = jest.fn().mockResolvedValue({ renewed: 3 });

    await expect(locks.runExclusive('billing:2026-11-01', 3600, job)).resolves.toEqual({
      renewed: 3,
    });
    expect(set).toHaveBeenCalledWith(
      'cron:billing:2026-11-01',
      expect.any(String),
      'EX',
      3600,
      'NX',
    );
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('skips the job and returns null when another instance holds the lock', async () => {
    set.mockResolvedValue(null);
    const job = jest.fn();

    await expect(locks.runExclusive('billing:2026-11-01', 3600, job)).resolves.toBeNull();
    expect(job).not.toHaveBeenCalled();
  });

  it('names daily locks by UTC date', () => {
    expect(CronLockService.daily('expiry', new Date('2026-11-01T23:30:00.000Z'))).toBe(
      'expiry:2026-11-01',
    );
  });
});
