import { IsInt, IsPositive, IsString, MaxLength } from 'class-validator';

export class CreateUploadDto {
  @IsString()
  @MaxLength(64)
  contentType!: string;

  @IsInt()
  @IsPositive()
  size!: number;
}
