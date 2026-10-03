DROP INDEX "purchase_items_purchase_idx";--> statement-breakpoint
ALTER TABLE "purchase_items" ADD COLUMN "line_number" smallint NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_line_key" UNIQUE("tenant_id","purchase_id","line_number");--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_line_number" CHECK ("purchase_items"."line_number" between 1 and 200);