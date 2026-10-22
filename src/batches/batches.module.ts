import { Module } from '@nestjs/common';
import { BatchesService } from './batches.service';
import { BatchesController } from './batches.controller';
import { ExpiryCronService } from './expiry-cron.service';

@Module({
  providers: [BatchesService, ExpiryCronService],
  controllers: [BatchesController],
  exports: [BatchesService, ExpiryCronService],
})
export class BatchesModule {}
