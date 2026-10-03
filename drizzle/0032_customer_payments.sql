CREATE TABLE "customer_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reference" text,
	"received_on" date NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_payments_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_payments_method" CHECK ("customer_payments"."method" in ('cash', 'card', 'upi')),
	CONSTRAINT "customer_payments_amount" CHECK ("customer_payments"."amount_paise" > 0 AND "customer_payments"."amount_paise" <= 100000000000),
	CONSTRAINT "customer_payments_reference_length" CHECK (char_length("customer_payments"."reference") <= 100)
);
--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_payments_customer_idx" ON "customer_payments" USING btree ("tenant_id","customer_id","received_on");--> statement-breakpoint

-- Hand-written part.
SELECT app_enable_tenant_rls('customer_payments');
--> statement-breakpoint
SELECT app_make_append_only('customer_payments');
--> statement-breakpoint
GRANT SELECT, INSERT ON customer_payments TO app_user;
