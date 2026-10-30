import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** `POST /api/admin/riders` — riders are created by staff, never self-registered. */
export class CreateRiderDto {
  @IsEmail({}, { message: 'Email must be a valid address' })
  @MaxLength(254)
  email!: string;

  /** SDS §7.4 password complexity, same rule as customer registration. */
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  @Matches(/[A-Za-z]/, { message: 'Password must include a letter' })
  @Matches(/[0-9]/, { message: 'Password must include a digit' })
  password!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(32)
  phone!: string;
}

/** `PATCH /api/admin/riders/:id`. */
export class UpdateRiderDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(32)
  phone?: string;
}
