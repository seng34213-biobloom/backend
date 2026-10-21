import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Wraps pgcrypto pgp_sym_encrypt / pgp_sym_decrypt for subscription
 * payment-token storage at rest (SDS §7.3). The key is sourced from
 * SUBSCRIPTION_TOKEN_ENC_KEY and bound as a SQL parameter — it never
 * appears inline in the query string and so doesn't leak via query logs.
 *
 * Stored shape: `bytea` column `subscription.payment_token_encrypted`.
 */
@Injectable()
export class TokenCipherService {
  private readonly key: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const k = config.get<string>('SUBSCRIPTION_TOKEN_ENC_KEY');
    if (!k || k.length < 16) {
      throw new Error('SUBSCRIPTION_TOKEN_ENC_KEY must be set (≥16 chars)');
    }
    this.key = k;
  }

  async encrypt(plaintext: string): Promise<Buffer> {
    if (!plaintext) throw new Error('Cannot encrypt empty plaintext');
    const rows = await this.prisma.$queryRaw<Array<{ enc: Buffer }>>(
      Prisma.sql`SELECT pgp_sym_encrypt(${plaintext}::text, ${this.key}::text) AS enc`,
    );
    if (!rows[0]?.enc) throw new Error('pgp_sym_encrypt returned no value');
    return rows[0].enc;
  }

  async decrypt(encrypted: Uint8Array): Promise<string> {
    if (!encrypted || encrypted.length === 0) {
      throw new Error('Cannot decrypt empty bytes');
    }
    // Prisma's pg driver needs a Node Buffer for bytea binding; we accept
    // either Uint8Array or Buffer at the call site.
    const asBuffer = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
    const rows = await this.prisma.$queryRaw<Array<{ dec: string }>>(
      Prisma.sql`SELECT pgp_sym_decrypt(${asBuffer}::bytea, ${this.key}::text) AS dec`,
    );
    if (!rows[0]?.dec) throw new Error('pgp_sym_decrypt returned no value');
    return rows[0].dec;
  }
}
