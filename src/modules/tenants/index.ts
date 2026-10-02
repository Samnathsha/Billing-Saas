// Public entry point of the tenants module. Other code imports only from
// "@/modules/tenants", never from files inside this folder.
export {
  businessProfileInput,
  getBusinessProfile,
  getPlanUsage,
  SettingsError,
  updateBusinessProfile,
  type BusinessProfileDto,
  type PlanUsageDto,
  type SettingsErrorCode,
} from "./service";
export { PlanLimitError, requireCapacity, type PlanLimitErrorCode, type PlanResource } from "./entitlements";
