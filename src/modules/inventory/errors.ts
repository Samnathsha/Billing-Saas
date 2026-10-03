// Errors of the inventory module with messages safe to show.

export type InventoryErrorCode = "ALREADY_HAS_STOCK_HISTORY" | "SERIAL_COUNT" | "SERIAL_TAKEN" | "SERIAL_NOT_IN_STOCK" | "ZERO_QUANTITY";

const MESSAGES: Record<InventoryErrorCode, string> = {
  ALREADY_HAS_STOCK_HISTORY: "This item already has stock history in this branch. Use a stock adjustment instead.",
  SERIAL_COUNT: "Enter one IMEI/serial number per unit.",
  SERIAL_TAKEN: "This IMEI/serial number is already recorded.",
  SERIAL_NOT_IN_STOCK: "This IMEI/serial number is not in stock in this branch.",
  ZERO_QUANTITY: "Enter a quantity above zero.",
};

export class InventoryError extends Error {
  constructor(
    public readonly code: InventoryErrorCode,
    public readonly detail?: string,
  ) {
    super(detail === undefined ? MESSAGES[code] : `${MESSAGES[code]} (${detail})`);
    this.name = "InventoryError";
  }
}
