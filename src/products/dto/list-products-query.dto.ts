import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListProductsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Transform(({ value }: { value: string }) => value?.trim())
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }: { value: string }) => value?.trim())
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  pageSize: number = 24;
}
