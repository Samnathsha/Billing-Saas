-- New permission "Manage products" (owner decision 2026-10-02, business
-- rules section 13): create and edit products, variants, barcodes and the
-- catalog lists. Default roles Owner, Admin and Manager get it, also in
-- businesses that already exist.

-- RLS binds migrator too (0002), so a temporary policy allows this one
-- insert and is dropped straight away.
CREATE POLICY tmp_add_permission ON permissions AS PERMISSIVE FOR INSERT TO migrator WITH CHECK (true);
--> statement-breakpoint
INSERT INTO permissions (code, description) VALUES ('products.manage', 'Manage products');
--> statement-breakpoint
DROP POLICY tmp_add_permission ON permissions;
--> statement-breakpoint

-- Existing businesses: RLS binds migrator too, so this data step adds
-- temporary policies and drops them in the same migration (pattern from
-- 0002 and 0012). Only the system roles with these exact names are changed.
CREATE POLICY tmp_backfill_roles ON roles AS PERMISSIVE FOR SELECT TO migrator USING (true);
--> statement-breakpoint
CREATE POLICY tmp_backfill_grants ON role_permissions AS PERMISSIVE FOR ALL TO migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, 'products.manage'
  FROM roles r
 WHERE r.is_system AND r.name IN ('Owner', 'Admin', 'Manager')
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions rp
      WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id AND rp.permission_code = 'products.manage'
   );
--> statement-breakpoint
DROP POLICY tmp_backfill_grants ON role_permissions;
--> statement-breakpoint
DROP POLICY tmp_backfill_roles ON roles;
