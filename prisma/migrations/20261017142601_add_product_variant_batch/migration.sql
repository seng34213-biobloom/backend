-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'DEPLETED');

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "base_price" DECIMAL(12,2) NOT NULL,
    "unit_weight_grams" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variant" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "unit_weight_grams" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_batch" (
    "id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "batch_number" TEXT NOT NULL,
    "manufactured_date" DATE NOT NULL,
    "expiry_date" DATE NOT NULL,
    "initial_quantity" INTEGER NOT NULL,
    "current_quantity" INTEGER NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_batch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_slug_key" ON "product"("slug");

-- CreateIndex
CREATE INDEX "product_category_active_idx" ON "product"("category", "active");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_sku_key" ON "product_variant"("sku");

-- CreateIndex
CREATE INDEX "product_variant_product_id_idx" ON "product_variant"("product_id");

-- CreateIndex
CREATE INDEX "product_batch_product_variant_id_expiry_date_idx" ON "product_batch"("product_variant_id", "expiry_date");

-- CreateIndex
CREATE INDEX "product_batch_expiry_date_idx" ON "product_batch"("expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "product_batch_product_variant_id_batch_number_key" ON "product_batch"("product_variant_id", "batch_number");

-- AddForeignKey
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_batch" ADD CONSTRAINT "product_batch_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint (not expressible in schema.prisma)
ALTER TABLE "product" ADD CONSTRAINT "product_base_price_check" CHECK ("base_price" >= 0);

-- AddCheckConstraint
ALTER TABLE "product" ADD CONSTRAINT "product_unit_weight_grams_check" CHECK ("unit_weight_grams" > 0);

-- AddCheckConstraint
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_price_check" CHECK ("price" >= 0);

-- AddCheckConstraint
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_unit_weight_grams_check" CHECK ("unit_weight_grams" > 0);

-- AddCheckConstraint
ALTER TABLE "product_batch" ADD CONSTRAINT "product_batch_quantity_check" CHECK ("initial_quantity" >= 0 AND "current_quantity" >= 0 AND "current_quantity" <= "initial_quantity");

-- AddCheckConstraint
ALTER TABLE "product_batch" ADD CONSTRAINT "product_batch_dates_check" CHECK ("expiry_date" >= "manufactured_date");
