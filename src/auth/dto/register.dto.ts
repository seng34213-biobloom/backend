import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Customer registration payload (SDS §5.1).
 * Staff/seller accounts are NOT created via this endpoint — admins are
 * seeded, sellers self-apply via Phase 3, delivery users are created by
 * an admin. This keeps the customer table free of privileged rows
 * (SDS §7.2 separation).
 */
export class RegisterDto {
  @IsEmail({}, { message: 'Email must be a valid address' })
  @MaxLength(254)
  email!: string;

  /**
   * SDS §7.4 — password complexity. Enforce minimum 8 chars with letter
   * and digit. bcrypt cost 12 is applied server-side.
   */
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  @Matches(/[A-Za-z]/, { message: 'Password must include a letter' })
  @Matches(/[0-9]/, { message: 'Password must include a digit' })
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;
}
