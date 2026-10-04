// Public entry point of the sync module. Other code imports only from
// "@/modules/sync", never from files inside this folder.
export { claimIdempotencyKey, IdempotencyError } from "./idempotency";
export { TillError, type TillErrorCode } from "./errors";
export { addTillAudit, earlierTillResult, hashTillToken, lockActiveTill, recordFlags, recordTillOperation, type ActiveTill, type NewFlag } from "./tills";
export {
  countOpenSyncFlags,
  getOfflineWindowHours,
  offlineWindowInput,
  setOfflineWindowHours,
  listSyncFlags,
  listTills,
  registerTill,
  registerTillInput,
  resolveFlagInput,
  resolveSyncFlag,
  revokeTill,
  revokeTillInput,
  type RegisteredTillDto,
  type SyncFlagCode,
  type SyncFlagDto,
  type TillDto,
} from "./tills.service";
export { SYNC_FLAG_CODES } from "./schema";
