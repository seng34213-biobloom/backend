import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { SellerService } from './seller.service';
import { ApplyDto } from './dto/apply.dto';

/**
 * Public seller-side endpoints. `apply` is rate-limited by the same
 * 20-per-15-min/IP "auth" bucket as register/login because, like those,
 * it's an unauthenticated form post.
 */
@Controller('sellers')
export class SellerController {
  constructor(private readonly sellers: SellerService) {}

  @Public()
  @Throttle({ auth: { limit: 20, ttl: 900_000 } })
  @Post('apply')
  @HttpCode(HttpStatus.CREATED)
  async apply(@Body() dto: ApplyDto) {
    return this.sellers.apply(dto);
  }
}
