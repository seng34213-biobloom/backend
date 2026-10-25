CREATE TYPE "DeliveryAssignmentStatus" AS ENUM (
    'ASSIGNED',
    'PICKED_UP',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'FAILED'
);

CREATE TABLE "delivery_assignment" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "delivery_user_id" UUID NOT NULL,
    "status" "DeliveryAssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "proof_photo_url" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "picked_up_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_assignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_assignment_order_id_key"
ON "delivery_assignment"("order_id");
CREATE INDEX "delivery_assignment_delivery_user_id_status_idx"
ON "delivery_assignment"("delivery_user_id", "status");

ALTER TABLE "delivery_assignment"
ADD CONSTRAINT "delivery_assignment_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "delivery_assignment"
ADD CONSTRAINT "delivery_assignment_delivery_user_id_fkey"
FOREIGN KEY ("delivery_user_id") REFERENCES "delivery_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
