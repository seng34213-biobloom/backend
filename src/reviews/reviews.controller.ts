import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CreateReviewDto } from './dto/create-review.dto';
import { ReviewsService } from './reviews.service';

@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Public()
  @Get('products/:productId/reviews')
  list(@Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string) {
    return this.reviews.listApproved(productId);
  }

  @Public()
  @Get('products/:productId/reviews/summary')
  summary(@Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string) {
    return this.reviews.summary(productId);
  }

  @Roles(Role.CUSTOMER)
  @Post('products/:productId/reviews')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: CreateReviewDto,
    @CurrentUser() customer: AuthenticatedUser,
  ) {
    return this.reviews.create(productId, customer.id, dto);
  }

  @Roles(Role.ADMIN)
  @Get('admin/reviews/pending')
  pending() {
    return this.reviews.listPending();
  }

  @Roles(Role.ADMIN)
  @Post('admin/reviews/:id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.reviews.approve(id, actor);
  }

  @Roles(Role.ADMIN)
  @Delete('admin/reviews/:id')
  reject(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.reviews.reject(id, actor);
  }
}
