CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED');

CREATE TABLE "product_review" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_review_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_review_rating_check" CHECK ("rating" BETWEEN 1 AND 5)
);

CREATE UNIQUE INDEX "product_review_customer_id_product_id_key"
ON "product_review"("customer_id", "product_id");
CREATE INDEX "product_review_product_id_status_created_at_idx"
ON "product_review"("product_id", "status", "created_at");
CREATE INDEX "product_review_order_id_idx" ON "product_review"("order_id");

ALTER TABLE "product_review"
ADD CONSTRAINT "product_review_customer_id_fkey"
FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "product_review"
ADD CONSTRAINT "product_review_product_id_fkey"
FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "product_review"
ADD CONSTRAINT "product_review_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
