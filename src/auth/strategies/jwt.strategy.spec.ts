import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  let redis: jest.Mocked<RedisService>;
  let strategy: JwtStrategy;

  beforeEach(() => {
    const config = {
      get: jest.fn().mockReturnValue('a'.repeat(32)),
    } as unknown as ConfigService;
    redis = {
      isJtiRevoked: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<RedisService>;
    strategy = new JwtStrategy(config, redis);
  });

  it('rejects tokens whose JTI has been revoked', async () => {
    redis.isJtiRevoked.mockResolvedValue(true);

    await expect(
      strategy.validate({
        sub: 'customer-1',
        role: 'CUSTOMER',
        actorType: 'customer',
        jti: 'revoked-token',
      }),
    ).rejects.toThrow(new UnauthorizedException('Token revoked'));
  });

  it('resolves a valid token into an authenticated user', async () => {
    await expect(
      strategy.validate({
        sub: 'customer-1',
        role: 'CUSTOMER',
        actorType: 'customer',
        jti: 'active-token',
        exp: 1_900_000_000,
      }),
    ).resolves.toEqual({
      id: 'customer-1',
      email: '',
      role: 'CUSTOMER',
      actorType: 'customer',
      jti: 'active-token',
      expiresAt: 1_900_000_000,
    });
    expect(redis.isJtiRevoked).toHaveBeenCalledWith('active-token');
  });

  it('rejects a token missing required claims before checking Redis', async () => {
    await expect(
      strategy.validate({
        sub: 'customer-1',
        role: 'CUSTOMER',
        actorType: 'customer',
      } as never),
    ).rejects.toThrow(new UnauthorizedException('Malformed token'));
    expect(redis.isJtiRevoked).not.toHaveBeenCalled();
  });
});
