// Public entry point of the inventory module. Other code imports only from
// "@/modules/inventory", never from files inside this folder.
export { assertStockTargets, belowZero, postMovements, StockError, type MovementInput, type StockErrorCode } from "./stock";
export { inStockSerialsAt, inStockSerialsOfPurchaseItem, markSerialsSold, receiveSerials, returnSerial, reverseStockOf, sendSerialsBack, takeSerialIfAvailable, takeSerialsForSale, unitCostsOf } from "./serials";
export { InventoryError, type InventoryErrorCode } from "./errors";
export { adjustStock, getStockLevels, recordOpeningStock, type StockLevelDto } from "./service";
