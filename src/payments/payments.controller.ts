import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CompletePaymentSetupDto, StartPaymentSetupDto } from './dto/payment-setup.dto';
import { PaymentsService } from './payments.service';

@Controller('webhooks')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  stripe(
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') signature?: string,
  ) {
    if (!request.rawBody) throw new BadRequestException('Missing raw Stripe webhook body');
    return this.payments.handleStripeWebhook(request.rawBody, signature);
  }

  @Public()
  @Post('payhere')
  @HttpCode(HttpStatus.OK)
  payhere(@Req() request: Request) {
    const payload = request.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException('Missing PayHere notification body');
    }
    return this.payments.handlePayHereWebhook(payload as Record<string, string>);
  }
}

/** Saves a card at the gateway for Subscribe & Save; the card never reaches this API. */
@Controller('payments/setup')
@Roles(Role.CUSTOMER)
export class PaymentSetupController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  start(@Body() dto: StartPaymentSetupDto, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.startSetup(user.id, dto.gateway, dto.returnUrl);
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  complete(@Body() dto: CompletePaymentSetupDto, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.completeSetup(user.id, dto.gateway, dto.sessionId);
  }
}
