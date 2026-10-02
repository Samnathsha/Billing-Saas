ALTER TABLE "settings" ADD COLUMN "invoice_prefix" text DEFAULT 'INV' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "credit_note_prefix" text DEFAULT 'CN' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_invoice_prefix_format" CHECK ("settings"."invoice_prefix" ~ '^[A-Z0-9]{1,4}$');--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_credit_note_prefix_format" CHECK ("settings"."credit_note_prefix" ~ '^[A-Z0-9]{1,4}$');--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_prefixes_differ" CHECK ("settings"."invoice_prefix" <> "settings"."credit_note_prefix");