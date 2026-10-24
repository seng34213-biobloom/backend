import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
import { CartModule } from './cart/cart.module';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';
import { CsrfMiddleware } from './common/middleware/csrf.middleware';
import { validateEnvironment } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { FulfilmentModule } from './fulfilment/fulfilment.module';
import { InventoryModule } from './inventory/inventory.module';
import { OrdersModule } from './orders/orders.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductsModule } from './products/products.module';
import { ShippingModule } from './shipping/shipping.module';
import { RedisModule } from './redis/redis.module';
import { RefundsModule } from './refunds/refunds.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { UploadsModule } from './uploads/uploads.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnvironment,
    }),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 100 },
      { name: 'auth', ttl: 900_000, limit: 20 },
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
    SubscriptionsModule,
    UploadsModule,
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
