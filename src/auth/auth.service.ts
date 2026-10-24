import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { ActorType, AuthenticatedUser, JwtPayload } from './types/auth.types';
import type { RegisterDto } from './dto/register.dto';
import type { LoginDto } from './dto/login.dto';

/** SDS §7.3 — bcrypt cost factor 12. */
export const BCRYPT_COST = 12;

export interface IssuedToken {
  token: string;
  jti: string;
  ttlSec: number;
  role: Role;
  actorType: ActorType;
  userId: string;
  email: string;
}

/**
 * Auth surface for Phase 2. Customer self-registration goes through
 * `registerCustomer`. Login routes through every actor table in the
 * security order admin → seller → delivery → customer; first match
 * with a valid bcrypt-compared password wins.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly customerTtl: string;
  private readonly staffTtl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.customerTtl = config.get<string>('JWT_CUSTOMER_TTL') ?? '15d';
    this.staffTtl = config.get<string>('JWT_STAFF_TTL') ?? '8h';
  }

  async registerCustomer(dto: RegisterDto): Promise<{ id: string; email: string; name: string }> {
    const email = dto.email.trim().toLowerCase();
    await this.assertEmailFree(email);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    const customer = await this.prisma.customer.create({
      data: {
        email,
        passwordHash,
        name: dto.name.trim(),
        phone: dto.phone?.trim(),
      },
      select: { id: true, email: true, name: true },
    });
    this.logger.log(`Customer registered ${customer.id}`);
    return customer;
  }

  async login(dto: LoginDto): Promise<IssuedToken> {
    const email = dto.email.trim().toLowerCase();
    const candidate = await this.findIdentity(email);
    if (!candidate) {
      // Constant-time-ish: still run bcrypt against a real (well-formed)
      // hash so timing doesn't leak which emails exist (SDS §7.4). The
      // plaintext is hash-of-empty-string at cost 12.
      await bcrypt.compare(
        dto.password,
        '$2a$12$Z3v4K1l3kLh4ZQyYwZ8XEuJZyXbXJWZP3kjOq.gQAB1qBh.t/JLrm',
      );
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcrypt.compare(dto.password, candidate.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.issueToken(candidate);
  }

  /** Revokes the JTI in Redis with the token's remaining TTL. */
  async logout(user: AuthenticatedUser): Promise<void> {
    const remaining = user.expiresAt - Math.floor(Date.now() / 1000);
    await this.redis.revokeJti(user.jti, remaining);
    this.logger.log(`Token revoked jti=${user.jti.slice(0, 8)} actor=${user.actorType}`);
  }

  /** Used by the /me endpoint — re-fetches identity from the source table. */
  async loadIdentity(user: AuthenticatedUser): Promise<{ id: string; email: string; role: Role }> {
    switch (user.actorType) {
      case 'admin': {
        const row = await this.prisma.adminUser.findUnique({
          where: { id: user.id },
          select: { id: true, email: true, role: true, active: true },
        });
        if (!row || !row.active) throw new UnauthorizedException();
        return { id: row.id, email: row.email, role: row.role as Role };
      }
      case 'seller': {
        const row = await this.prisma.seller.findUnique({
          where: { id: user.id },
          select: { id: true, email: true, status: true },
        });
        if (!row || row.status !== 'APPROVED') throw new UnauthorizedException();
        return { id: row.id, email: row.email, role: Role.SELLER };
      }
      case 'delivery': {
        const row = await this.prisma.deliveryUser.findUnique({
          where: { id: user.id },
          select: { id: true, email: true, active: true },
        });
        if (!row || !row.active) throw new UnauthorizedException();
        return { id: row.id, email: row.email, role: Role.DELIVERY };
      }
      case 'customer': {
        const row = await this.prisma.customer.findUnique({
          where: { id: user.id },
          select: { id: true, email: true },
        });
        if (!row) throw new UnauthorizedException();
        return { id: row.id, email: row.email, role: Role.CUSTOMER };
      }
    }
  }

  /**
   * Throws ConflictException if `email` already exists in any actor table
   * (customer / adminUser / seller / deliveryUser). Public so SellerService
   * (Phase 3) and future actor-creating flows can re-use the same check.
   */
  async assertEmailFree(email: string): Promise<void> {
    const conflict =
      (await this.prisma.customer.findUnique({ where: { email }, select: { id: true } })) ||
      (await this.prisma.adminUser.findUnique({ where: { email }, select: { id: true } })) ||
      (await this.prisma.seller.findUnique({ where: { email }, select: { id: true } })) ||
      (await this.prisma.deliveryUser.findUnique({ where: { email }, select: { id: true } }));
    if (conflict) {
      throw new ConflictException('Email already registered');
    }
  }

  // ----- internals -------------------------------------------------------

  private async findIdentity(email: string): Promise<{
    id: string;
    email: string;
    passwordHash: string;
    role: Role;
    actorType: ActorType;
  } | null> {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    if (admin) {
      if (!admin.active) throw new ForbiddenException('Account disabled');
      return {
        id: admin.id,
        email: admin.email,
        passwordHash: admin.passwordHash,
        role: admin.role as Role,
        actorType: 'admin',
      };
    }
    const seller = await this.prisma.seller.findUnique({ where: { email } });
    if (seller) {
      if (seller.status !== 'APPROVED') {
        throw new ForbiddenException('Seller account not yet approved');
      }
      return {
        id: seller.id,
        email: seller.email,
        passwordHash: seller.passwordHash,
        role: Role.SELLER,
        actorType: 'seller',
      };
    }
    const delivery = await this.prisma.deliveryUser.findUnique({ where: { email } });
    if (delivery) {
      if (!delivery.active) throw new ForbiddenException('Account disabled');
      return {
        id: delivery.id,
        email: delivery.email,
        passwordHash: delivery.passwordHash,
        role: Role.DELIVERY,
        actorType: 'delivery',
      };
    }
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (customer) {
      return {
        id: customer.id,
        email: customer.email,
        passwordHash: customer.passwordHash,
        role: Role.CUSTOMER,
        actorType: 'customer',
      };
    }
    return null;
  }

  private async issueToken(candidate: {
    id: string;
    email: string;
    role: Role;
    actorType: ActorType;
  }): Promise<IssuedToken> {
    const jti = randomUUID();
    const expiresIn = candidate.actorType === 'customer' ? this.customerTtl : this.staffTtl;
    const ttlSec = parseTtl(expiresIn);
    const payload: JwtPayload = {
      sub: candidate.id,
      role: candidate.role,
      actorType: candidate.actorType,
      jti,
    };
    const token = await this.jwt.signAsync(payload, {
      expiresIn: ttlSec,
      algorithm: 'HS256',
    });
    return {
      token,
      jti,
      ttlSec,
      role: candidate.role,
      actorType: candidate.actorType,
      userId: candidate.id,
      email: candidate.email,
    };
  }
}

/**
 * Convert a JWT-style TTL string ('15d', '8h', '30m', '120s') to seconds.
 * Exported only for unit tests.
 */
export function parseTtl(spec: string): number {
  const match = /^([0-9]+)([smhd])$/.exec(spec.trim());
  if (!match) throw new Error(`Invalid TTL: ${spec}`);
  const n = Number(match[1]);
  switch (match[2]) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    default:
      throw new Error(`Invalid TTL: ${spec}`);
  }
}
