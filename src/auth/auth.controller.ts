import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AUTH_COOKIE_NAME } from './strategies/jwt.strategy';
import { CSRF_COOKIE_NAME } from '../common/middleware/csrf.middleware';
import type { AuthenticatedUser } from './types/auth.types';

@Controller('auth')
export class AuthController {
  private readonly cookieSecure: boolean;

  constructor(private readonly auth: AuthService) {
    this.cookieSecure = process.env.NODE_ENV === 'production';
  }

  // SDS §7.4 — burst limit on registration (20 / 15 min / IP).
  @Public()
  @Throttle({ auth: { limit: 20, ttl: 900_000 } })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto): Promise<{ id: string; email: string; name: string }> {
    return this.auth.registerCustomer(dto);
  }

  // SDS §7.4 — login limited to 20 attempts per IP per 15-min window.
  @Public()
  @Throttle({ auth: { limit: 20, ttl: 900_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ role: string; userId: string; email: string }> {
    const issued = await this.auth.login(dto);
    res.cookie(AUTH_COOKIE_NAME, issued.token, {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: 'strict',
      maxAge: issued.ttlSec * 1000,
      path: '/',
    });
    return { role: issued.role, userId: issued.userId, email: issued.email };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(user);
    res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
  }

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser): Promise<{
    id: string;
    email: string;
    role: string;
    actorType: string;
  }> {
    const identity = await this.auth.loadIdentity(user);
    return {
      id: identity.id,
      email: identity.email,
      role: identity.role,
      actorType: user.actorType,
    };
  }

  /**
   * Issues / refreshes the CSRF token cookie. Public so the frontend can
   * prime the cookie before any state-mutating call (SDS §7.4 double-submit).
   */
  @Public()
  @Get('csrf')
  csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response): { csrfToken: string } {
    const existing = req.cookies?.[CSRF_COOKIE_NAME];
    const token =
      existing && /^[a-f0-9]{32,}$/i.test(existing) ? existing : randomBytes(24).toString('hex');
    if (!existing) {
      res.cookie(CSRF_COOKIE_NAME, token, {
        httpOnly: false,
        secure: this.cookieSecure,
        sameSite: 'strict',
        path: '/',
      });
    }
    return { csrfToken: token };
  }
}
