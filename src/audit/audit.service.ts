import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Append-only audit log. SDS §7.2 — every privileged admin or seller
 * mutation must land a row here so the admin audit views can
 * reconstruct any change. Failures here are logged
 * but never block the request — auditing a successful action twice is
 * far better than rolling back a real-world state change because the
 * log write blipped.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorType: entry.actorType,
          actorId: entry.actorId,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          metadata: (entry.metadata ?? null) as never,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
        },
      });
    } catch (e) {
      this.logger.error(
        `audit-log write failed for ${entry.action} on ${entry.targetType}:${entry.targetId} — ${
          (e as Error).message
        }`,
      );
    }
  }
}
