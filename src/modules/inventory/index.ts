// Public entry point of the inventory module. Other code imports only from
// "@/modules/inventory", never from files inside this folder.
export { postMovements, StockError, type MovementInput, type StockErrorCode } from "./stock";
export {
  adjustStock,
  getStockLevels,
  InventoryError,
  recordOpeningStock,
  type InventoryErrorCode,
  type StockLevelDto,
} from "./service";
