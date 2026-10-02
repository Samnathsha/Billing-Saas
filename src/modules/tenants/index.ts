// Public entry point of the tenants module. Other code imports only from
// "@/modules/tenants", never from files inside this folder.
export {
  businessProfileInput,
  getBusinessProfile,
  SettingsError,
  updateBusinessProfile,
  type BusinessProfileDto,
  type SettingsErrorCode,
} from "./service";
