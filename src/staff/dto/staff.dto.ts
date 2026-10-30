import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AdminRole } from '@prisma/client';

/** `POST /api/admin/staff` — an ADMIN or FULFILMENT_STAFF console account. */
export class CreateStaffDto {
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

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsEnum(AdminRole)
  role!: AdminRole;
}

/** `PATCH /api/admin/staff/:id`. */
export class UpdateStaffDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsEnum(AdminRole)
  role?: AdminRole;
}
