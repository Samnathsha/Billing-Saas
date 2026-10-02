import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  // Tests run on the server side, where "server-only" is a no-op.
  "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    testTimeout: 30_000,
    projects: [
      {
        // `npm test`: fast, no database needed.
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "tests/lint/**/*.test.ts"],
        },
      },
      {
        // `npm run test:db`: real PostgreSQL test database (DATABASE_URL_TEST).
        extends: true,
        test: {
          name: "db",
          include: ["tests/integration/**/*.test.ts", "tests/isolation/**/*.test.ts"],
          setupFiles: ["tests/setup-db-env.ts"],
          hookTimeout: 60_000,
          // One file at a time: these tests share one database.
          fileParallelism: false,
        },
      },
    ],
  },
});
