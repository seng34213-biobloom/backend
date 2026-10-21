import { SetMetadata } from '@nestjs/common';

/** Routes annotated with @Public() are exempt from JwtAuthGuard. */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
