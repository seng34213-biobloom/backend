import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';

@Module({
  imports: [AuthModule],
  providers: [StaffService],
  controllers: [StaffController],
  exports: [StaffService],
})
export class StaffModule {}
