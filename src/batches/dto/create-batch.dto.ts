import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateBatchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  batchNumber!: string;

  /** ISO date — manufactured_date column is `@db.Date`. */
  @IsDateString()
  manufacturedDate!: string;

  /** ISO date. Must be in the future when posted (validated in service). */
  @IsDateString()
  expiryDate!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  initialQuantity!: number;
}
