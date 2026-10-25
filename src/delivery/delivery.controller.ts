import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { DeliveryService } from './delivery.service';
import { RegisterFcmTokenDto } from './dto/fcm-token.dto';
import { UpdateDeliveryStatusDto } from './dto/update-status.dto';
import { UploadDeliveryProofDto } from './dto/upload-proof.dto';

@Controller('delivery')
@Roles(Role.DELIVERY)
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  @Get('assignments')
  list(@CurrentUser() rider: AuthenticatedUser) {
    return this.delivery.listForRider(rider.id);
  }

  @Post('assignments/:id/status')
  @HttpCode(HttpStatus.OK)
  updateStatus(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateDeliveryStatusDto,
    @CurrentUser() rider: AuthenticatedUser,
  ) {
    return this.delivery.updateStatus(id, dto, rider);
  }

  @Post('assignments/:id/proof')
  @HttpCode(HttpStatus.OK)
  uploadProof(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UploadDeliveryProofDto,
    @CurrentUser() rider: AuthenticatedUser,
  ) {
    return this.delivery.uploadProof(id, dto, rider);
  }

  @Put('fcm-token')
  @HttpCode(HttpStatus.OK)
  registerFcmToken(@Body() dto: RegisterFcmTokenDto, @CurrentUser() rider: AuthenticatedUser) {
    return this.delivery.registerFcmToken(dto, rider);
  }
}
