-- The fixed permission list, one row per action in blueprint table 5.3.
-- Which role gets which permission is set per business when it is created
-- (Phase 3). New permissions are added by new migrations, never by the app.
INSERT INTO "permissions" ("code", "description") VALUES
  ('sales.create',          'Create a sale'),
  ('invoices.void',         'Void a posted invoice'),
  ('discounts.above_limit', 'Give a discount above the cashier limit'),
  ('prices.change',         'Change a selling price'),
  ('stock.adjust',          'Make a stock adjustment'),
  ('purchases.create',      'Create a purchase'),
  ('costs.view',            'View cost price and profit'),
  ('reports.view',          'View reports and export data'),
  ('users.manage',          'Manage users and roles'),
  ('settings.manage',       'Change business and tax settings'),
  ('business.delete',       'Delete the business or transfer ownership');
