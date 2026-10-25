import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTicketDto {
  @IsString()
  @MinLength(5)
  @MaxLength(160)
  @Transform(({ value }: { value: string }) => value?.trim())
  subject!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  @Transform(({ value }: { value: string }) => value?.trim())
  message!: string;
}
