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
  voidInvoice,
  voidInvoiceInput,
  type InvoiceDto,
  type InvoiceListItemDto,
} from "./service";
export { SalesError, type SalesErrorCode } from "./errors";
export { getPosSetup, priceItemsForSale, priceItemsInput, type PosItemDto, type PosSetupDto } from "./pos.service";
export { customerPaymentInput, listCustomerPayments, recordCustomerPayment, type CustomerPaymentDto } from "./payments.service";
export { createReturn, createReturnInput, getCreditNote, getReturnable, type CreditNoteDto, type ReturnableDto, type ReturnableLineDto } from "./returns.service";
export { createExchange, createExchangeInput } from "./exchange.service";
export { applyOfflineOperation, getTillSnapshot, type OfflineResultDto } from "./offline.service";
export type { OfflineOperation, OfflineReturnOp, OfflineSaleOp, TillSnapshotDto } from "./offline-core";
