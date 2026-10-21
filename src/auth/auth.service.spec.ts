import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuthService, BCRYPT_COST, parseTtl } from './auth.service';
import type { AuthenticatedUser } from './types/auth.types';

describe('AuthService', () => {
  let svc: AuthService;
  let prisma: jest.Mocked<PrismaService>;
  let jwt: jest.Mocked<JwtService>;
  let redis: jest.Mocked<RedisService>;

  const table = () => ({ findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() });

  beforeEach(() => {
    prisma = {
      customer: table(),
      adminUser: table(),
      seller: table(),
      deliveryUser: table(),
    } as unknown as jest.Mocked<PrismaService>;
    jwt = {
      signAsync: jest.fn().mockResolvedValue('signed.jwt.token'),
    } as unknown as jest.Mocked<JwtService>;
    redis = { revokeJti: jest.fn() } as unknown as jest.Mocked<RedisService>;
    const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    svc = new AuthService(prisma, jwt, redis, config);
  });

  describe('registerCustomer', () => {
    it('hashes the password with bcrypt cost 12 and normalises the email', async () => {
      (prisma.customer.create as jest.Mock).mockImplementation(async ({ data }) => ({
        id: 'c1',
        email: data.email,
        name: data.name,
      }));

      const out = await svc.registerCustomer({
        email: '  Nimal@Example.COM ',
        password: 'secret123',
        name: ' Nimal ',
      });

      const data = (prisma.customer.create as jest.Mock).mock.calls[0][0].data;
      expect(data.email).toBe('nimal@example.com');
      expect(data.name).toBe('Nimal');
      expect(data.passwordHash).not.toBe('secret123');
      expect(bcrypt.getRounds(data.passwordHash)).toBe(BCRYPT_COST);
      expect(await bcrypt.compare('secret123', data.passwordHash)).toBe(true);
      expect(out).toEqual({ id: 'c1', email: 'nimal@example.com', name: 'Nimal' });
    });

    it('rejects an email that already exists in any actor table', async () => {
      (prisma.seller.findUnique as jest.Mock).mockResolvedValue({ id: 's1' });

      await expect(
        svc.registerCustomer({ email: 'shop@example.com', password: 'secret123', name: 'Shop' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.customer.create).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    const hash = bcrypt.hashSync('secret123', 4);

    it('issues a customer token with a 15 day TTL for valid credentials', async () => {
      (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
        id: 'c1',
        email: 'nimal@example.com',
        passwordHash: hash,
      });

      const out = await svc.login({ email: 'Nimal@example.com', password: 'secret123' });

      expect(out).toMatchObject({
        token: 'signed.jwt.token',
        role: 'CUSTOMER',
        actorType: 'customer',
        userId: 'c1',
        ttlSec: 15 * 86400,
      });
      const [payload, options] = (jwt.signAsync as jest.Mock).mock.calls[0];
      expect(payload).toMatchObject({ sub: 'c1', role: 'CUSTOMER', actorType: 'customer' });
      expect(payload.jti).toEqual(out.jti);
      expect(options).toEqual({ expiresIn: '15d', algorithm: 'HS256' });
    });

    it('issues a staff token with an 8 hour TTL for an admin', async () => {
      (prisma.adminUser.findUnique as jest.Mock).mockResolvedValue({
        id: 'a1',
        email: 'admin@example.com',
        passwordHash: hash,
        role: 'ADMIN',
        active: true,
      });

      const out = await svc.login({ email: 'admin@example.com', password: 'secret123' });

      expect(out).toMatchObject({ role: 'ADMIN', actorType: 'admin', ttlSec: 8 * 3600 });
      expect(prisma.customer.findUnique).not.toHaveBeenCalled();
    });

    it('logs in approved sellers and active delivery users', async () => {
      (prisma.seller.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 's1',
        email: 'shop@example.com',
        passwordHash: hash,
        status: 'APPROVED',
      });
      await expect(
        svc.login({ email: 'shop@example.com', password: 'secret123' }),
      ).resolves.toMatchObject({ role: 'SELLER', actorType: 'seller' });

      (prisma.deliveryUser.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'd1',
        email: 'rider@example.com',
        passwordHash: hash,
        active: true,
      });
      await expect(
        svc.login({ email: 'rider@example.com', password: 'secret123' }),
      ).resolves.toMatchObject({ role: 'DELIVERY', actorType: 'delivery' });
    });

    it('rejects a wrong password with 401', async () => {
      (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
        id: 'c1',
        email: 'nimal@example.com',
        passwordHash: hash,
      });

      await expect(
        svc.login({ email: 'nimal@example.com', password: 'wrong-pass1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('rejects an unknown email with 401', async () => {
      await expect(
        svc.login({ email: 'nobody@example.com', password: 'secret123' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('blocks disabled staff, unapproved sellers and disabled riders with 403', async () => {
      (prisma.adminUser.findUnique as jest.Mock).mockResolvedValueOnce({ active: false });
      await expect(svc.login({ email: 'a@example.com', password: 'x' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      (prisma.seller.findUnique as jest.Mock).mockResolvedValueOnce({ status: 'PENDING' });
      await expect(svc.login({ email: 's@example.com', password: 'x' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      (prisma.deliveryUser.findUnique as jest.Mock).mockResolvedValueOnce({ active: false });
      await expect(svc.login({ email: 'd@example.com', password: 'x' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('logout', () => {
    it('revokes the JTI for the remaining token lifetime', async () => {
      const now = Math.floor(Date.now() / 1000);
      await svc.logout({ jti: 'jti-1', expiresAt: now + 600 } as AuthenticatedUser);

      const [jti, ttl] = (redis.revokeJti as jest.Mock).mock.calls[0];
      expect(jti).toBe('jti-1');
      expect(ttl).toBeGreaterThan(590);
      expect(ttl).toBeLessThanOrEqual(600);
    });
  });

  describe('loadIdentity', () => {
    const user = (actorType: AuthenticatedUser['actorType']) =>
      ({ id: 'u1', actorType }) as AuthenticatedUser;

    it('returns the identity from the matching actor table', async () => {
      (prisma.adminUser.findUnique as jest.Mock).mockResolvedValue({
        id: 'u1',
        email: 'admin@example.com',
        role: 'ADMIN',
        active: true,
      });
      (prisma.seller.findUnique as jest.Mock).mockResolvedValue({
        id: 'u1',
        email: 'shop@example.com',
        status: 'APPROVED',
      });
      (prisma.deliveryUser.findUnique as jest.Mock).mockResolvedValue({
        id: 'u1',
        email: 'rider@example.com',
        active: true,
      });
      (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
        id: 'u1',
        email: 'nimal@example.com',
      });

      await expect(svc.loadIdentity(user('admin'))).resolves.toMatchObject({ role: 'ADMIN' });
      await expect(svc.loadIdentity(user('seller'))).resolves.toMatchObject({ role: 'SELLER' });
      await expect(svc.loadIdentity(user('delivery'))).resolves.toMatchObject({
        role: 'DELIVERY',
      });
      await expect(svc.loadIdentity(user('customer'))).resolves.toMatchObject({
        role: 'CUSTOMER',
      });
    });

    it.each(['admin', 'seller', 'delivery', 'customer'] as const)(
      'rejects a %s that no longer exists with 401',
      async (actorType) => {
        await expect(svc.loadIdentity(user(actorType))).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      },
    );
  });

  describe('parseTtl', () => {
    it('converts TTL strings to seconds', () => {
      expect(parseTtl('120s')).toBe(120);
      expect(parseTtl('30m')).toBe(1800);
      expect(parseTtl('8h')).toBe(28800);
      expect(parseTtl('15d')).toBe(1296000);
    });

    it('rejects an invalid TTL', () => {
      expect(() => parseTtl('15 days')).toThrow(/Invalid TTL/);
    });
  });
});
