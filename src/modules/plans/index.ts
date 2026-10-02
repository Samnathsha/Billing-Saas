// Public entry point of the plans module (plans, subscriptions and their
// limits). It depends on no other module, so auth and tenants can both use
// it. Other code imports only from "@/modules/plans".
export {
  limitOf,
  PlanLimitError,
  readPlanUsage,
  requireCapacity,
  type PlanLimitErrorCode,
  type PlanResource,
} from "./entitlements";
