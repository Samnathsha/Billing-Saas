// Public entry point of the maintenance module (Phase 11): platform jobs
// that belong to no business. The route that calls them checks its own key.
export { compactOldRows } from "./compact";
