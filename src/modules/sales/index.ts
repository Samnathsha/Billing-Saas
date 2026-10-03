// Public entry point of the sales module. Other code imports only from
// "@/modules/sales", never from files inside this folder.
export {
  financialYearLabel,
  financialYearStart,
  formatDocumentNumber,
  PREFIX_PATTERN,
} from "./numbering";
export { SeriesFullError, takeNextNumber } from "./sequence";
export {
  createSale,
  createSaleInput,
  getInvoice,
  listInvoices,
  SalesError,
  voidInvoice,
  voidInvoiceInput,
  type InvoiceDto,
  type InvoiceListItemDto,
  type SalesErrorCode,
} from "./service";
export { getPosSetup, priceItemsForSale, priceItemsInput, type PosItemDto, type PosSetupDto } from "./pos.service";
