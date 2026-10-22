import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
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
