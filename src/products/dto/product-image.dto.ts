import { IsIn, IsInt, IsOptional, IsString, IsUrl, IsUUID, MaxLength, Min } from 'class-validator';

export const PRODUCT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export class AddProductImageDto {
  @IsUrl({ protocols: ['https', 'http'], require_tld: false })
  @MaxLength(2048)
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  altText?: string;
}

export class PresignProductImageDto {
  @IsUUID('4')
  productId!: string;

  @IsIn(PRODUCT_IMAGE_TYPES, { message: 'contentType must be image/jpeg, image/png or image/webp' })
  contentType!: string;

  // Larger files are answered with 413 by UploadsService
  @IsInt()
  @Min(1)
  sizeBytes!: number;
}
