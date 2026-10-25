import { IsEnum } from 'class-validator';
import { SupportTicketStatus } from '@prisma/client';

export class UpdateTicketStatusDto {
  @IsEnum(SupportTicketStatus)
  status!: SupportTicketStatus;
}
