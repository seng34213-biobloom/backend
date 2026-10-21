import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

describe('RedisService', () => {
  const createService = () => {
    const client = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
    };
    const config = {
      get: jest.fn().mockReturnValue('redis://localhost:6379'),
    } as unknown as ConfigService;
    const service = new RedisService(config);
    Object.defineProperty(service, 'client', { value: client });
    return { service, client };
  };

  it('stores a revoked JTI under its namespaced key with an integer expiry', async () => {
    const { service, client } = createService();

    await service.revokeJti('token-id', 123.9);

    expect(client.set).toHaveBeenCalledWith('jti:token-id', '1', 'EX', 123);
  });

  it('keeps the Redis expiry valid for an already-expired token', async () => {
    const { service, client } = createService();

    await service.revokeJti('expired-token', 0);

    expect(client.set).toHaveBeenCalledWith('jti:expired-token', '1', 'EX', 1);
  });

  it('reports whether a JTI is present in the revocation list', async () => {
    const { service, client } = createService();
    client.get.mockResolvedValueOnce('1').mockResolvedValueOnce(null);

    await expect(service.isJtiRevoked('revoked')).resolves.toBe(true);
    await expect(service.isJtiRevoked('active')).resolves.toBe(false);
    expect(client.get).toHaveBeenNthCalledWith(1, 'jti:revoked');
    expect(client.get).toHaveBeenNthCalledWith(2, 'jti:active');
  });
});
