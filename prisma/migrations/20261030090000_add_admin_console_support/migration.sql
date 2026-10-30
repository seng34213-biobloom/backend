-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED');

-- AlterTable
ALTER TABLE "order" ADD COLUMN     "cancellation_reason" TEXT,
ADD COLUMN     "order_number" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "allergens" TEXT,
ADD COLUMN     "ingredients" TEXT;

-- CreateTable
CREATE TABLE "product_image" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "alt_text" TEXT NOT NULL DEFAULT '',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle" (
    "id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "total_weight_g" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_item" (
    "id" UUID NOT NULL,
    "bundle_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "bundle_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_code" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "discount_type" "DiscountType" NOT NULL,
    "discount_value" DECIMAL(12,2) NOT NULL,
    "min_order_lkr" DECIMAL(12,2),
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "max_uses" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_code_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_image_product_id_sort_order_idx" ON "product_image"("product_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_slug_key" ON "bundle"("slug");

-- CreateIndex
CREATE INDEX "bundle_seller_id_idx" ON "bundle"("seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_item_bundle_id_product_variant_id_key" ON "bundle_item"("bundle_id", "product_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "promo_code_code_key" ON "promo_code"("code");

-- CreateIndex
CREATE INDEX "promo_code_code_active_idx" ON "promo_code"("code", "active");

-- CreateIndex
CREATE UNIQUE INDEX "order_order_number_key" ON "order"("order_number");

-- AddForeignKey
ALTER TABLE "product_image" ADD CONSTRAINT "product_image_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle" ADD CONSTRAINT "bundle_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_item" ADD CONSTRAINT "bundle_item_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_item" ADD CONSTRAINT "bundle_item_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

