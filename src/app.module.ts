import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AddressesModule } from './addresses/addresses.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { BatchesModule } from './batches/batches.module';
import { CartModule } from './cart/cart.module';
import { CsrfMiddleware } from './common/middleware/csrf.middleware';
import { HealthModule } from './health/health.module';
import { FulfilmentModule } from './fulfilment/fulfilment.module';
import { InventoryModule } from './inventory/inventory.module';
import { OrdersModule } from './orders/orders.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductsModule } from './products/products.module';
import { ReviewsModule } from './reviews/reviews.module';
import { ShippingModule } from './shipping/shipping.module';
import { RedisModule } from './redis/redis.module';
import { RefundsModule } from './refunds/refunds.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { SupportModule } from './support/support.module';

// Metadata key that @Throttle({ auth }) writes on a route.
const AUTH_THROTTLE_KEY = 'THROTTLER:LIMITauth';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    // SDS §7.4 — "default" applies to every route, "auth" only to routes marked
    // @Throttle({ auth }). @nestjs/throttler 6 applies every named throttler to
    // every route unless it is skipped.
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 100 },
      {
        name: 'auth',
        ttl: 900_000,
        limit: 20,
        skipIf: (context) =>
          !Reflect.hasMetadata(AUTH_THROTTLE_KEY, context.getHandler()) &&
          !Reflect.hasMetadata(AUTH_THROTTLE_KEY, context.getClass()),
      },
    ]),
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
    BatchesModule,
    CartModule,
    ShippingModule,
    OrdersModule,
    AnalyticsModule,
    FulfilmentModule,
    RefundsModule,
    ReviewsModule,
    SupportModule,
    SubscriptionsModule,
    HealthModule,
    AuthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CsrfMiddleware).forRoutes('*');
  }
}
