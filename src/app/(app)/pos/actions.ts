"use server";

import { revalidatePath } from "next/cache";
import { listProducts, variantLabel } from "@/modules/catalog";
import { createCustomer, getCustomer, listCustomers, type CustomerDto } from "@/modules/parties";
import { createSale, priceItemsForSale, type PosItemDto } from "@/modules/sales";
import { errorMessage, memberCtx } from "@/app/(app)/_shared/action-result";

// The till screen's server calls. Who and which business come from the
// session; everything else is checked by the services. Prices shown on the
// screen come from here, and the sale is recomputed on the server.

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function run<T>(work: (ctx: NonNullable<Awaited<ReturnType<typeof memberCtx>>>) => Promise<T>): Promise<Result<T>> {
  const ctx = await memberCtx();
  if (ctx === null) return { ok: false, error: "Please log in again." };
  try {
    return { ok: true, value: await work(ctx) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function priceItemsAction(input: { branchId: string; codes?: string[]; variantIds?: string[] }): Promise<Result<[string, PosItemDto][]>> {
  return run(async (ctx) => [...(await priceItemsForSale(ctx, input))]);
}

export interface SearchHit {
  variantId: string;
  name: string;
  sku: string;
}

export async function searchItemsAction(q: string): Promise<Result<SearchHit[]>> {
  return run(async (ctx) => {
    const { products } = await listProducts(ctx, { page: 1, q: q.slice(0, 100) });
    return products
      .filter((p) => p.active)
      .flatMap((p) =>
        p.variants
          .filter((v) => v.active)
          .map((v) => {
            const label = variantLabel(v.attributes);
            return { variantId: v.id, name: label === "" ? p.name : `${p.name} · ${label}`, sku: v.sku };
          }),
      )
      .slice(0, 20);
  });
}

export async function findCustomersAction(q: string): Promise<Result<CustomerDto[]>> {
  return run(async (ctx) => (await listCustomers(ctx, { q: q.slice(0, 100) })).slice(0, 10));
}

export async function addCustomerAction(input: { name: string; phone: string }): Promise<Result<CustomerDto>> {
  return run(async (ctx) => {
    const { id } = await createCustomer(ctx, { name: input.name, phone: input.phone, gstin: "", stateCode: "" });
    return getCustomer(ctx, { id });
  });
}

export async function saleAction(input: unknown): Promise<Result<{ invoiceId: string }>> {
  const result = await run((ctx) => createSale(ctx, input));
  if (result.ok) {
    revalidatePath("/sales");
    revalidatePath("/inventory");
  }
  return result;
}
