-- One payment per subscription billing cycle (DDP-#23)
ALTER TABLE "payment" ADD COLUMN "billing_cycle_key" TEXT;

CREATE UNIQUE INDEX "payment_billing_cycle_key_key" ON "payment"("billing_cycle_key");
