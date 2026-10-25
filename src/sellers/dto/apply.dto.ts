import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Seller signup payload. The resulting row is created with status=PENDING
 * (SDS multi-seller extension, SRS FR001–002). The seller cannot log in
 * until an admin approves the application — AuthService rejects PENDING
 * sellers with 403 in Phase 2.
 */
export class ApplyDto {
  @IsEmail({}, { message: 'Email must be a valid address' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  @Matches(/[A-Za-z]/, { message: 'Password must include a letter' })
  @Matches(/[0-9]/, { message: 'Password must include a digit' })
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  businessName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  contactName!: string;

  @IsString()
  @MinLength(7)
  @MaxLength(32)
  phone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxId?: string;
}
