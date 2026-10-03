ALTER TABLE "serial_numbers" DROP CONSTRAINT "serial_numbers_status_valid";--> statement-breakpoint
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_status_valid" CHECK ("serial_numbers"."status" in ('in_stock', 'sold', 'returned', 'scrapped', 'voided'));--> statement-breakpoint

-- Hand-written: the purchase line a serial number came in on (the column
-- exists since migration 0020; its table since 0025).
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_purchase_item_fk"
  FOREIGN KEY ("tenant_id", "purchase_item_id") REFERENCES "purchase_items" ("tenant_id", "id") ON DELETE RESTRICT;
