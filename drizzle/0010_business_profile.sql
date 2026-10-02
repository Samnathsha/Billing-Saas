ALTER TABLE "settings" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "state_code" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "pincode" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "gst_registration" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "gstin" text;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_address_lengths" CHECK (char_length("settings"."address_line1") <= 200 AND char_length("settings"."address_line2") <= 200 AND char_length("settings"."city") <= 100);--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_state_code_format" CHECK ("settings"."state_code" ~ '^[0-9]{2}$');--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_pincode_format" CHECK ("settings"."pincode" ~ '^[1-9][0-9]{5}$');--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_phone_format" CHECK ("settings"."phone" ~ '^[+0-9 -]{6,20}$');--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_contact_email_length" CHECK (char_length("settings"."contact_email") <= 254);--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_gst_registration_valid" CHECK ("settings"."gst_registration" in ('registered', 'composition', 'unregistered'));--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_gstin_format" CHECK ("settings"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_gstin_matches_registration" CHECK (("settings"."gstin" IS NOT NULL) = ("settings"."gst_registration" IS NOT NULL AND "settings"."gst_registration" <> 'unregistered'));--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_gstin_matches_state" CHECK ("settings"."gstin" IS NULL OR ("settings"."state_code" IS NOT NULL AND left("settings"."gstin", 2) = "settings"."state_code"));