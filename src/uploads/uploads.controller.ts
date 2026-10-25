import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CreateUploadDto } from './dto/create-upload.dto';
import { UploadsService } from './uploads.service';

@Controller('uploads')
@Roles(Role.ADMIN, Role.FULFILMENT_STAFF, Role.DELIVERY)
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('presign')
  createUpload(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateUploadDto) {
    return this.uploads.createUpload(user, dto);
  }

  @Post(':uploadId/verify')
  verifyUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('uploadId', new ParseUUIDPipe({ version: '4' })) uploadId: string,
  ) {
    return this.uploads.verifyUpload(user, uploadId);
  }
}
