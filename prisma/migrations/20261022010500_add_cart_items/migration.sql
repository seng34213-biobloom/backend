CREATE TABLE "cart_item" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cart_item_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cart_item_customer_id_idx" ON "cart_item"("customer_id");

CREATE UNIQUE INDEX "cart_item_customer_id_product_variant_id_key"
ON "cart_item"("customer_id", "product_variant_id");

ALTER TABLE "cart_item"
ADD CONSTRAINT "cart_item_customer_id_fkey"
FOREIGN KEY ("customer_id") REFERENCES "customer"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cart_item"
ADD CONSTRAINT "cart_item_product_variant_id_fkey"
FOREIGN KEY ("product_variant_id") REFERENCES "product_variant"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
