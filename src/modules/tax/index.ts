// Public entry point of the tax module. Other code imports only from
// "@/modules/tax", never from files inside this folder.
export {
  GST_REGISTRATIONS,
  GST_STATES,
  gstinProblem,
  isGstStateCode,
  needsGstin,
  normaliseGstin,
  type GstinProblem,
  type GstRegistration,
} from "./gst";
export { pickTaxRate, TaxRateError, type TaxRateRow } from "./rates";
