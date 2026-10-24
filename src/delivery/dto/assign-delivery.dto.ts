import { IsUUID } from 'class-validator';

export class AssignDeliveryDto {
  @IsUUID('4')
  orderId!: string;

  @IsUUID('4')
  deliveryUserId!: string;
}
