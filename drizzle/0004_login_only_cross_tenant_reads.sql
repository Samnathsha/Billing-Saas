-- Tighten the two "across businesses" read rules from migration 0002.
--
-- They let a user see their own memberships in every business, and those
-- businesses' rows, so login can list the businesses to choose from. That
-- is only needed BEFORE a business is chosen. Inside a business they are
-- not needed, and a mismatched context (business A + a user of business B)
-- would have revealed B's name and membership. Now they apply only when no
-- business is set.

DROP POLICY own_memberships ON memberships;
--> statement-breakpoint
CREATE POLICY own_memberships ON memberships AS PERMISSIVE FOR SELECT TO app_user
  USING (
    (SELECT app_current_tenant_id()) IS NULL
    AND user_id = (SELECT app_current_user_id())
  );
--> statement-breakpoint
DROP POLICY tenant_read ON tenants;
--> statement-breakpoint
CREATE POLICY tenant_read ON tenants AS PERMISSIVE FOR SELECT TO app_user
  USING (
    id = (SELECT app_current_tenant_id())
    OR (
      (SELECT app_current_tenant_id()) IS NULL
      AND id IN (SELECT m.tenant_id FROM memberships m
                 WHERE m.user_id = (SELECT app_current_user_id()) AND m.status = 'active')
    )
  );
