import { Transform, Type } from 'class-transformer';
import { DeliveryAssignmentStatus } from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateDeliveryStatusDto {
  @IsEnum(DeliveryAssignmentStatus)
  status!: DeliveryAssignmentStatus;

  @ValidateIf((dto: UpdateDeliveryStatusDto) => dto.status === DeliveryAssignmentStatus.DELIVERED)
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ValidateIf((dto: UpdateDeliveryStatusDto) => dto.status === DeliveryAssignmentStatus.DELIVERED)
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ValidateIf((dto: UpdateDeliveryStatusDto) => dto.status === DeliveryAssignmentStatus.FAILED)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  @Transform(({ value }: { value: string }) => value?.trim())
  failureReason?: string;
}
