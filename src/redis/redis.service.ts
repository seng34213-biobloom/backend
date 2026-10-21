import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Thin ioredis wrapper. SDS §2.1.4 — Redis is the JWT JTI blocklist and
 * (Phase 5) the shipping-rate-bracket cache. Lazy connect so unit tests
 * with `disableRedis: true` don't open sockets.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      this.logger.log('Redis connected');
    } catch (e) {
      this.logger.error(`Redis connect failed: ${(e as Error).message}`);
      throw e;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status === 'ready' || this.client.status === 'connecting') {
      await this.client.quit();
    }
  }

  /**
   * Add a JWT JTI to the revocation list with TTL equal to the token's
   * remaining lifetime (SDS §5.1, §7.1). Any later request bearing this
   * token is rejected by the JwtAuthGuard.
   */
  async revokeJti(jti: string, expiresInSec: number): Promise<void> {
    // Clamp to >=1 so SET EX never throws on already-expired tokens.
    const ttl = Math.max(1, Math.floor(expiresInSec));
    await this.client.set(this.jtiKey(jti), '1', 'EX', ttl);
  }

  async isJtiRevoked(jti: string): Promise<boolean> {
    const v = await this.client.get(this.jtiKey(jti));
    return v !== null;
  }

  /** Raw ioredis access for downstream services (shipping cache, etc.). */
  getClient(): Redis {
    return this.client;
  }

  private jtiKey(jti: string): string {
    return `jti:${jti}`;
  }
}
