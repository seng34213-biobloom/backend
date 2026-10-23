CREATE TYPE "OrderStatus" AS ENUM (
    'PENDING_PAYMENT',
    'PAID',
    'PACKING',
    'SHIPPED',
    'DELIVERED',
    'CANCELLED',
    'REFUNDED'
);

CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');

CREATE TABLE "order" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "shipping_address_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "total_amount" DECIMAL(12,2) NOT NULL,
    "total_weight" DECIMAL(12,2) NOT NULL,
    "shipping_fee" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'LKR',
    "placed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shipped_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_item" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_snapshot" DECIMAL(12,2) NOT NULL,
    "line_total" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "order_item_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shipping_rate" (
    "id" UUID NOT NULL,
    "min_weight_g" INTEGER NOT NULL,
    "max_weight_g" INTEGER NOT NULL,
    "fee_lkr" DECIMAL(12,2) NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "shipping_rate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "order_id" UUID,
    "subscription_id" UUID,
    "gateway" "PaymentGateway" NOT NULL,
    "gateway_payment_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'LKR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "raw_payload" JSONB,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shipping_rate_min_weight_g_max_weight_g_key"
ON "shipping_rate"("min_weight_g", "max_weight_g");
CREATE INDEX "order_customer_id_placed_at_idx" ON "order"("customer_id", "placed_at");
CREATE INDEX "order_status_idx" ON "order"("status");
CREATE INDEX "order_item_order_id_idx" ON "order_item"("order_id");
CREATE UNIQUE INDEX "payment_gateway_payment_id_key" ON "payment"("gateway_payment_id");
CREATE INDEX "payment_order_id_idx" ON "payment"("order_id");
CREATE INDEX "payment_subscription_id_idx" ON "payment"("subscription_id");

ALTER TABLE "order"
ADD CONSTRAINT "order_customer_id_fkey"
FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order"
ADD CONSTRAINT "order_shipping_address_id_fkey"
FOREIGN KEY ("shipping_address_id") REFERENCES "address"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_item"
ADD CONSTRAINT "order_item_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_item"
ADD CONSTRAINT "order_item_product_variant_id_fkey"
FOREIGN KEY ("product_variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_item"
ADD CONSTRAINT "order_item_batch_id_fkey"
FOREIGN KEY ("batch_id") REFERENCES "product_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment"
ADD CONSTRAINT "payment_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment"
ADD CONSTRAINT "payment_subscription_id_fkey"
FOREIGN KEY ("subscription_id") REFERENCES "subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "shipping_rate" ("id", "min_weight_g", "max_weight_g", "fee_lkr", "label") VALUES
    (gen_random_uuid(), 0, 500, 350.00, '0–500 g'),
    (gen_random_uuid(), 501, 1000, 500.00, '501 g – 1 kg'),
    (gen_random_uuid(), 1001, 2000, 750.00, '1–2 kg'),
    (gen_random_uuid(), 2001, 5000, 1100.00, '2–5 kg'),
    (gen_random_uuid(), 5001, 999999, 1800.00, '5 kg+');
