-- pgcrypto provides pgp_sym_encrypt / pgp_sym_decrypt for subscription payment tokens (SDS §7.3)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentGateway" AS ENUM ('STRIPE', 'PAYHERE');

-- CreateTable
CREATE TABLE "address" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "postal_code" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL DEFAULT 'LK',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "shipping_address_id" UUID NOT NULL,
    "frequency_days" INTEGER NOT NULL,
    "discount_rate" DECIMAL(5,4) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "next_billing_date" DATE NOT NULL,
    "payment_token_encrypted" BYTEA NOT NULL,
    "payment_gateway" "PaymentGateway" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "address_customer_id_idx" ON "address"("customer_id");

-- CreateIndex
CREATE INDEX "subscription_status_next_billing_date_idx" ON "subscription"("status", "next_billing_date");

-- CreateIndex
CREATE INDEX "subscription_customer_id_idx" ON "subscription"("customer_id");

-- AddForeignKey
ALTER TABLE "address" ADD CONSTRAINT "address_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_shipping_address_id_fkey" FOREIGN KEY ("shipping_address_id") REFERENCES "address"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddCheckConstraint (not expressible in schema.prisma)
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_frequency_days_check" CHECK ("frequency_days" IN (14, 30, 60));

-- AddCheckConstraint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_quantity_check" CHECK ("quantity" BETWEEN 1 AND 10);

-- AddCheckConstraint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_discount_rate_check" CHECK ("discount_rate" >= 0 AND "discount_rate" < 1);
