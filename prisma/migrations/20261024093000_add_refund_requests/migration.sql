CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSED');

CREATE TABLE "refund_request" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "processed_at" TIMESTAMP(3),
    "processed_by_admin_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refund_request_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "refund_request_status_idx" ON "refund_request"("status");
CREATE INDEX "refund_request_order_id_idx" ON "refund_request"("order_id");

ALTER TABLE "refund_request"
ADD CONSTRAINT "refund_request_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_request"
ADD CONSTRAINT "refund_request_customer_id_fkey"
FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
