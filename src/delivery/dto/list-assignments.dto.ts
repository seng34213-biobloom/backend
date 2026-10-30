import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DeliveryAssignmentStatus } from '@prisma/client';

/** `GET /api/admin/delivery-assignments` filters. */
export class ListAssignmentsQueryDto {
  @IsOptional()
  @IsEnum(DeliveryAssignmentStatus)
  status?: DeliveryAssignmentStatus;

  @IsOptional()
  @IsUUID('4')
  deliveryUserId?: string;
}
