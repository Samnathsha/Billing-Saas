// Public entry point of the reports module. Other code imports only from
// "@/modules/reports", never from files inside this folder.
export {
  dateRangeInput,
  getAgeing,
  getDashboard,
  getLowStock,
  getPaymentsReport,
  getProfitReport,
  getSalesBreakdown,
  getSalesReport,
  getStockValue,
  getTaxSummary,
  listAuditLog,
  type AgeingRowDto,
  type AuditEntryDto,
  type BreakdownRowDto,
  type DashboardDto,
  type PaymentsReportDto,
  type ProfitReportDto,
  type SalesReportDto,
  type TaxSummaryDto,
} from "./service";
