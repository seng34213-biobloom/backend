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
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CreateReviewDto, SubmitReviewDto } from './dto/create-review.dto';
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

  @Roles(Role.CUSTOMER)
  @Post('reviews')
  @HttpCode(HttpStatus.CREATED)
  createFromBody(@Body() dto: SubmitReviewDto, @CurrentUser() customer: AuthenticatedUser) {
    return this.reviews.create(dto.productId, customer.id, dto);
  }

  @Roles(Role.ADMIN)
  @Get('admin/reviews')
  listAdmin(@Query('approved') approved?: string) {
    return this.reviews.listForAdmin(
      approved === 'true' ? true : approved === 'false' ? false : undefined,
    );
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
  @Post('admin/reviews/:id/reject')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.reviews.remove(id, actor);
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
