// The local throwaway test database (docs/database-setup.md). Fixed here, so
// the flow tests can never point at Neon. No passwords: it trusts local
// connections.
const LOCAL_DB = "localhost:55432/billing_test";
export const LOCAL_APP_DB_URL = `postgresql://app_user@${LOCAL_DB}`;
export const LOCAL_AUTH_DB_URL = `postgresql://auth_service@${LOCAL_DB}`;
