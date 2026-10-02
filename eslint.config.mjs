import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

// ---------------------------------------------------------------------------
// Import rules. They enforce the dependency rules in CLAUDE.md and blueprint
// section 9:
//   app -> modules -> db/lib. Nothing imports upward.
//   A module is used only through its index.ts.
//   Only src/db opens a database connection; only repo.ts and schema.ts
//   use Drizzle query helpers.
// ESLint does not merge `no-restricted-imports` across blocks, so each folder
// gets its full list built from these pieces.
// ---------------------------------------------------------------------------

const noParentRelative = {
  regex: "^\\.\\./",
  message: "Use the @/ alias for imports outside this folder, not '../'.",
};
const noDeepModuleImport = {
  group: ["@/modules/*/**"],
  message: "Use another module only through its index.ts: import from '@/modules/<name>'.",
};
const noModules = (allowTypeImports = false) => ({
  group: ["@/modules", "@/modules/**"],
  allowTypeImports,
  message: "This layer must not import business modules (nothing imports upward).",
});
const noDb = {
  group: ["@/db", "@/db/**"],
  message: "Only modules may use the database. Call a module's index.ts instead.",
};
const noApp = {
  group: ["@/app", "@/app/**"],
  message: "Nothing may import from app/ (nothing imports upward).",
};
const noComponents = {
  group: ["@/components", "@/components/**"],
  message: "Business and data code must not import UI components.",
};
const noDbDriver = {
  group: ["pg", "pg/**", "postgres", "drizzle-orm/node-postgres", "drizzle-orm/postgres-js"],
  message: "Only src/db may open a database connection.",
};
const noDrizzle = {
  group: ["drizzle-orm", "drizzle-orm/**"],
  message: "Database queries belong in a module's repo.ts.",
};
const noDrizzleValues = {
  group: ["drizzle-orm", "drizzle-orm/**"],
  allowTypeImports: true,
  message: "Only repo.ts (queries) and schema.ts (tables) may use Drizzle. Put the query in repo.ts.",
};
const noDbClient = {
  group: ["@/db/client"],
  message: "Use withTenant() from '@/db/with-tenant'; never the raw client.",
};
const noAuthDbClient = {
  group: ["@/db/auth-client"],
  message: "Only the auth module may use the login library's database connection (ADR 0003).",
};

// Building a business context or a user-only transaction is reserved for the
// auth module, which checks the membership first (ADR 0003).
const sessionOnlyApis = {
  name: "@/db/with-tenant",
  importNames: ["createTenantContext", "withUserTransaction"],
  message: "Only the auth module may create a TenantContext or a user transaction (it checks the membership first).",
};

const restrictImports = (...patterns) => ({
  "no-restricted-imports": ["error", { paths: [sessionOnlyApis], patterns }],
});
// For src/db (defines them) and src/modules/auth (the only caller).
const restrictImportsAllowSessionApis = (...patterns) => ({
  "no-restricted-imports": ["error", { patterns }],
});

// ---------------------------------------------------------------------------
// Banned syntax: XSS sinks and SQL built from strings.
// Drizzle's tagged sql`...${value}` is allowed: it sends values as parameters.
// ---------------------------------------------------------------------------

const SQL_START = "/^\\s*(select|insert|update|delete|with|create|alter|drop|truncate|grant|revoke|merge)\\b/i";
const QUERY_METHOD = "/^(query|execute|unsafe|\\$queryRawUnsafe|\\$executeRawUnsafe)$/";

const bannedSyntax = [
  // XSS
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: "dangerouslySetInnerHTML is banned. Render text through React instead.",
  },
  {
    selector: "Property[key.name='dangerouslySetInnerHTML']",
    message: "dangerouslySetInnerHTML is banned. Render text through React instead.",
  },
  {
    selector: "AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]",
    message: "Writing innerHTML/outerHTML is banned (XSS risk).",
  },
  {
    selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
    message: "insertAdjacentHTML is banned (XSS risk).",
  },
  {
    selector: "MemberExpression[object.name='document'][property.name=/^(write|writeln)$/]",
    message: "document.write is banned (XSS risk).",
  },
  // String-built SQL
  {
    selector: "MemberExpression[object.name='sql'][property.name='raw']",
    message: "sql.raw() is banned: it skips parameters. Use the sql`...` tag with ${values}.",
  },
  {
    selector: `:not(TaggedTemplateExpression) > TemplateLiteral[expressions.length>0][quasis.0.value.raw=${SQL_START}]`,
    message: "SQL built with a template string is banned. Use Drizzle or the sql`...` tag.",
  },
  {
    selector: `BinaryExpression[operator='+'] > Literal[value=${SQL_START}]`,
    message: "SQL built by joining strings is banned. Use Drizzle or the sql`...` tag.",
  },
  {
    selector: `BinaryExpression[operator='+'] > TemplateLiteral[quasis.0.value.raw=${SQL_START}]`,
    message: "SQL built by joining strings is banned. Use Drizzle or the sql`...` tag.",
  },
  {
    selector: `CallExpression[callee.property.name=${QUERY_METHOD}] > TemplateLiteral[expressions.length>0]`,
    message: "Do not pass a built string to a query function. Use the sql`...` tag.",
  },
  {
    selector: `CallExpression[callee.property.name=${QUERY_METHOD}] > BinaryExpression[operator='+']`,
    message: "Do not pass a built string to a query function. Use the sql`...` tag.",
  },
];

// ---------------------------------------------------------------------------
// Permission checks (blueprint 5.3). Every exported function in a module's
// service.ts takes `ctx` first and starts with
//   await requirePermission(ctx, "...");
// Exports must be plain `export async function` declarations so this can be
// checked; and index.ts may not hand out repo.ts queries, which would skip
// the service and its check.
// ---------------------------------------------------------------------------

const PERMISSION_CHECK =
  "ExpressionStatement[expression.type='AwaitExpression'][expression.argument.callee.name='requirePermission'][expression.argument.arguments.0.name='ctx']";

const serviceSyntax = [
  {
    selector: `ExportNamedDeclaration > FunctionDeclaration > BlockStatement > :first-child:not(${PERMISSION_CHECK})`,
    message: "A service function must start with: await requirePermission(ctx, \"...\");",
  },
  {
    selector: "ExportNamedDeclaration > FunctionDeclaration > BlockStatement[body.length=0]",
    message: "A service function must start with: await requirePermission(ctx, \"...\");",
  },
  {
    selector: "ExportNamedDeclaration > FunctionDeclaration:not([params.0.name='ctx'])",
    message: "A service function takes the TenantContext `ctx` as its first parameter.",
  },
  {
    selector: "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > :matches(ArrowFunctionExpression, FunctionExpression).init",
    message: "Export service functions as `export async function name(ctx, ...)` so the permission check can be verified.",
  },
  {
    selector: "ExportDefaultDeclaration, ExportAllDeclaration, ExportSpecifier",
    message: "service.ts declares each export directly (`export async function ...`), so every one is checked.",
  },
];

const moduleIndexSyntax = [
  {
    selector: "ExportNamedDeclaration[source.value=/(^|\\/)repo$/], ExportAllDeclaration[source.value=/(^|\\/)repo$/]",
    message: "Do not export repo.ts from index.ts: callers must go through service functions (permission check).",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // Strict, type-aware TypeScript rules.
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Rules for every file.
  {
    linterOptions: {
      // eslint-disable comments are ignored, so a rule cannot be switched off
      // quietly in one file. Change this config (with review) instead.
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "react/no-danger": "error",
      "no-restricted-syntax": ["error", ...bannedSyntax],
      "no-eval": "error",
      "no-new-func": "error",
      "no-console": ["error", { allow: ["error"] }],
      eqeqeq: ["error", "always"],
    },
  },

  // Layer rules, one block per folder.
  {
    files: ["src/app/**"],
    rules: restrictImports(noParentRelative, noDeepModuleImport, noDb, noDbDriver, noDrizzle),
  },
  {
    files: ["src/components/**"],
    rules: restrictImports(noParentRelative, noModules(true), noDb, noApp, noDbDriver, noDrizzle),
  },
  {
    files: ["src/modules/**"],
    rules: restrictImports(
      noParentRelative,
      noDeepModuleImport,
      noApp,
      noComponents,
      noDbDriver,
      noDrizzleValues,
      noDbClient,
      noAuthDbClient,
    ),
  },
  {
    // The auth module runs Better Auth on its own connection (ADR 0003).
    files: ["src/modules/auth/**"],
    rules: restrictImportsAllowSessionApis(
      noParentRelative,
      noDeepModuleImport,
      noApp,
      noComponents,
      noDbDriver,
      noDrizzleValues,
      noDbClient,
    ),
  },
  {
    files: ["src/modules/**/repo.ts"],
    rules: restrictImports(noParentRelative, noDeepModuleImport, noApp, noComponents, noDbDriver, noDbClient, noAuthDbClient),
  },
  {
    // The auth module's queries: may use the login library's connection
    // (sessions) and the user/tenant transaction helpers.
    files: ["src/modules/auth/repo.ts"],
    rules: restrictImportsAllowSessionApis(noParentRelative, noDeepModuleImport, noApp, noComponents, noDbDriver, noDbClient),
  },
  {
    // Tables reference other modules' tables (e.g. memberships -> tenants),
    // so schema.ts may import another module's schema.ts, and nothing else.
    files: ["src/modules/**/schema.ts"],
    rules: restrictImports(noParentRelative, noApp, noComponents, noDbDriver, noDbClient, {
      regex: "^@/modules/[^/]+/(?!schema$).+",
      message: "schema.ts may import only another module's schema ('@/modules/<name>/schema').",
    }),
  },
  {
    files: ["src/db/**"],
    rules: restrictImportsAllowSessionApis(noParentRelative, noModules(), noApp, noComponents),
  },
  {
    // db/schema/index.ts gathers every module's tables for Drizzle.
    files: ["src/db/schema/**"],
    rules: restrictImportsAllowSessionApis(noParentRelative, noApp, noComponents, {
      regex: "^@/modules(?!/[^/]+/schema$)(/.*)?$",
      message: "db/schema may import only '@/modules/<name>/schema'.",
    }),
  },
  {
    files: ["src/lib/**"],
    rules: restrictImports(noParentRelative, noModules(), noDb, noApp, noComponents, noDbDriver, noDrizzle),
  },

  {
    // ESLint replaces (does not merge) a rule's options per block, so the
    // general banned syntax is repeated here.
    files: ["src/modules/*/service.ts"],
    rules: { "no-restricted-syntax": ["error", ...bannedSyntax, ...serviceSyntax] },
  },
  {
    files: ["src/modules/*/index.ts"],
    rules: { "no-restricted-syntax": ["error", ...bannedSyntax, ...moduleIndexSyntax] },
  },

  {
    // Command-line scripts talk to the person running them.
    files: ["scripts/**"],
    rules: { "no-console": "off" },
  },

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
