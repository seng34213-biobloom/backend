import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TokenCipherService } from './token-cipher.service';

const KEY = 'unit-test-key-0123456789';

describe('TokenCipherService', () => {
  let prisma: jest.Mocked<PrismaService>;
  let cipher: TokenCipherService;

  const config = (key: string | undefined) =>
    ({ get: jest.fn().mockReturnValue(key) }) as unknown as ConfigService;

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn() } as unknown as jest.Mocked<PrismaService>;
    cipher = new TokenCipherService(prisma, config(KEY));
  });

  it('refuses to start without a key of at least 16 characters', () => {
    expect(() => new TokenCipherService(prisma, config(undefined))).toThrow(/at least|≥16/);
    expect(() => new TokenCipherService(prisma, config('short'))).toThrow(/at least|≥16/);
  });

  it('binds the token and the key as query parameters', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ enc: Buffer.from('cipher') }]);

    await expect(cipher.encrypt('pm_test_123')).resolves.toEqual(Buffer.from('cipher'));

    const query = (prisma.$queryRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;
    expect(query.values).toEqual(['pm_test_123', KEY]);
    expect(query.sql).not.toContain(KEY);
    expect(query.sql).toContain('pgp_sym_encrypt');
  });

  it('decrypts bytes from either a Buffer or a Uint8Array', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ dec: 'pm_test_123' }]);

    await expect(cipher.decrypt(Buffer.from('cipher'))).resolves.toBe('pm_test_123');
    await expect(cipher.decrypt(new Uint8Array([1, 2, 3]))).resolves.toBe('pm_test_123');

    const query = (prisma.$queryRaw as jest.Mock).mock.calls[1][0] as Prisma.Sql;
    expect(Buffer.isBuffer(query.values[0])).toBe(true);
    expect(query.values[1]).toBe(KEY);
  });

  it('rejects empty input', async () => {
    await expect(cipher.encrypt('')).rejects.toThrow(/empty/);
    await expect(cipher.decrypt(new Uint8Array())).rejects.toThrow(/empty/);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('fails loudly when pgcrypto returns nothing', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    await expect(cipher.encrypt('pm_test_123')).rejects.toThrow(/no value/);
    await expect(cipher.decrypt(Buffer.from('cipher'))).rejects.toThrow(/no value/);
  });
});
