CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

CREATE TABLE "support_ticket" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "subject" VARCHAR(160) NOT NULL,
    "message" TEXT NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "resolved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_ticket_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_ticket_customer_id_created_at_idx"
ON "support_ticket"("customer_id", "created_at");
CREATE INDEX "support_ticket_status_created_at_idx"
ON "support_ticket"("status", "created_at");

ALTER TABLE "support_ticket"
ADD CONSTRAINT "support_ticket_customer_id_fkey"
FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
