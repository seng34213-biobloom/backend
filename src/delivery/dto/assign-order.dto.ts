import { IsUUID } from 'class-validator';

export class AssignOrderDto {
  @IsUUID('4')
  deliveryUserId!: string;
}
