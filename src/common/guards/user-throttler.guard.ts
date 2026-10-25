import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(
    request: Parameters<ThrottlerGuard['getTracker']>[0],
  ): Promise<string> {
    const authenticatedRequest = request as typeof request & {
      user?: { id?: string };
      socket?: { remoteAddress?: string };
    };
    return (
      authenticatedRequest.user?.id ??
      authenticatedRequest.ip ??
      authenticatedRequest.socket?.remoteAddress ??
      'unknown'
    );
  }
}
