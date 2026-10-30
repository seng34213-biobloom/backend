import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AddressesModule } from './addresses/addresses.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { BatchesModule } from './batches/batches.module';
import { BundlesModule } from './bundles/bundles.module';
import { CartModule } from './cart/cart.module';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';
import { CsrfMiddleware } from './common/middleware/csrf.middleware';
import { validateEnvironment } from './config/env.validation';
import { DeliveryModule } from './delivery/delivery.module';
import { HealthModule } from './health/health.module';
import { FulfilmentModule } from './fulfilment/fulfilment.module';
import { InventoryModule } from './inventory/inventory.module';
import { OrdersModule } from './orders/orders.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductsModule } from './products/products.module';
import { PromoCodesModule } from './promo-codes/promo-codes.module';
import { ReviewsModule } from './reviews/reviews.module';
import { ShippingModule } from './shipping/shipping.module';
import { StaffModule } from './staff/staff.module';
import { RedisModule } from './redis/redis.module';
import { RefundsModule } from './refunds/refunds.module';
import { SellerModule } from './sellers/seller.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { UploadsModule } from './uploads/uploads.module';
import { SupportModule } from './support/support.module';

// Metadata key that @Throttle({ auth }) writes on a route.
const AUTH_THROTTLE_KEY = 'THROTTLER:LIMITauth';

// A positive whole number from the environment, or the SDS §7.4 default
function limitFrom(config: ConfigService, key: string, fallback: number): number {
  const value = Number(config.get(key));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnvironment,
    }),
    // SDS §7.4 — "default" applies to every route, "auth" only to routes marked
    // @Throttle({ auth }). @nestjs/throttler 6 applies every named throttler to
    // every route unless it is skipped.
    // The limits default to 100 per minute and 20 auth requests per 15 minutes;
    // THROTTLE_* raises them for load tests run from one machine.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          name: 'default',
          ttl: limitFrom(config, 'THROTTLE_DEFAULT_TTL_MS', 60_000),
          limit: limitFrom(config, 'THROTTLE_DEFAULT_LIMIT', 100),
        },
        {
          name: 'auth',
          ttl: limitFrom(config, 'THROTTLE_AUTH_TTL_MS', 900_000),
          limit: limitFrom(config, 'THROTTLE_AUTH_LIMIT', 20),
          skipIf: (context) =>
            !Reflect.hasMetadata(AUTH_THROTTLE_KEY, context.getHandler()) &&
            !Reflect.hasMetadata(AUTH_THROTTLE_KEY, context.getClass()),
        },
      ],
    }),
    // SDS §4.2 — feature modules emit domain events; NotificationsService sends the emails.
    EventEmitterModule.forRoot(),
    // SDS §5.6 — daily scheduled jobs such as the batch expiry sweep.
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    AddressesModule,
    AuditModule,
    NotificationsModule,
    InventoryModule,
    ProductsModule,
    BundlesModule,
    PromoCodesModule,
    StaffModule,
    BatchesModule,
    CartModule,
    DeliveryModule,
    ShippingModule,
    OrdersModule,
    AnalyticsModule,
    FulfilmentModule,
    RefundsModule,
    ReviewsModule,
    SupportModule,
    SubscriptionsModule,
    UploadsModule,
    SellerModule,
    HealthModule,
    AuthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CsrfMiddleware).forRoutes('*');
  }
}
