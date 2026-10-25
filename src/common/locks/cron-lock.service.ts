import { Injectable, Logger } from '@nestjs/common';
import { hostname } from 'node:os';
import { RedisService } from '../../redis/redis.service';

/**
 * SDS §8.1 runs one to three API tasks, and each has its own @Cron timers.
 * A job wrapped in `runExclusive` runs on whichever instance first takes its
 * Redis lock (`SET cron:<name> <instance> NX EX <ttl>`); the others skip.
 * The lock is left to expire rather than released, so a second trigger in
 * the same period is skipped as well.
 */
@Injectable()
export class CronLockService {
  private readonly logger = new Logger(CronLockService.name);
  private readonly instanceId = `${hostname()}:${process.pid}`;

  constructor(private readonly redis: RedisService) {}

  /** Lock name for a job that runs once per UTC day, e.g. `billing:2026-11-01`. */
  static daily(job: string, at: Date = new Date()): string {
    return `${job}:${at.toISOString().slice(0, 10)}`;
  }

  async runExclusive<T>(name: string, ttlSec: number, fn: () => Promise<T>): Promise<T | null> {
    const key = `cron:${name}`;
    const acquired = await this.redis.getClient().set(key, this.instanceId, 'EX', ttlSec, 'NX');
    if (acquired !== 'OK') {
      this.logger.log(`Skipped ${name}: another instance holds ${key}`);
      return null;
    }
    return fn();
  }
}
