import { Module } from '@nestjs/common';
import { CronLockService } from '../common/locks/cron-lock.service';
import { BatchesService } from './batches.service';
import { BatchesController } from './batches.controller';
import { ExpiryCronService } from './expiry-cron.service';

@Module({
  providers: [BatchesService, ExpiryCronService, CronLockService],
  controllers: [BatchesController],
  exports: [BatchesService, ExpiryCronService],
})
export class BatchesModule {}
