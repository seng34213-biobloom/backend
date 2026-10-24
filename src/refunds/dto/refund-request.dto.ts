import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateRefundRequestDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount?: number;
}

export class RejectRefundDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
