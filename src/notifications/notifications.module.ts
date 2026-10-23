import { Global, Module } from '@nestjs/common';
import { MailerService } from './mailer.service';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  providers: [MailerService, NotificationsService],
  exports: [MailerService, NotificationsService],
})
export class NotificationsModule {}
