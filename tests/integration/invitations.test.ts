import { asc, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, invitations, memberships, roles } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import {
  acceptInvitation,
  AcceptInvitationError,
  createBusiness,
  getRequestContext,
  InvitationError,
  inviteStaff,
  listStaff,
  PermissionDeniedError,
  revokeInvitation,
} from "@/modules/auth";
import { sentTestEmails } from "@/modules/auth/mailer";
import { PlanLimitError } from "@/modules/plans";
import { getPlanUsage } from "@/modules/tenants";
import { registerVerifiedUser, type TestLogin } from "../helpers/auth";

// Staff invitations: invite by email, accept by link (once, 7 days, only
// the invited address), revoke, re-invite, plan limit, permissions.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function memberCtx(headers: Headers): Promise<TenantContext> {
  const result = await getRequestContext(headers);
  if (result.kind !== "member") throw new Error(`expected a member, got ${result.kind}`);
  return result.ctx;
}

async function newShop(label: string): Promise<{ owner: TestLogin; ctx: TenantContext }> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template: "clothing" });
  return { owner, ctx: await memberCtx(owner.headers) };
}

async function roleId(ctx: TenantContext, name: string): Promise<string> {
  const [role] = await withTenant(ctx, (tx) => tx.select({ id: roles.id }).from(roles).where(eq(roles.name, name)));
  return role?.id ?? "";
}

// The token from the newest invitation email to this address.
function tokenSentTo(email: string): string {
  const mail = [...sentTestEmails()].reverse().find((m) => m.to === email && m.subject.startsWith("You are invited"));
  const link = mail?.text.match(/https?:\/\/\S+/)?.[0];
  if (link === undefined) throw new Error(`no invitation email to ${email}`);
  return new URL(link).searchParams.get("token") ?? "";
}

async function invite(ctx: TenantContext, email: string, role = "Cashier"): Promise<string> {
  await inviteStaff(ctx, { email, roleId: await roleId(ctx, role) });
  return tokenSentTo(email.toLowerCase());
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (
      error instanceof AcceptInvitationError ||
      error instanceof InvitationError ||
      error instanceof PermissionDeniedError ||
      error instanceof PlanLimitError
    ) {
      return error.code;
    }
    throw error;
  }
}

async function auditActions(ctx: TenantContext): Promise<string[]> {
  const rows = await withTenant(ctx, (tx) =>
    tx.select({ action: auditLogs.action }).from(auditLogs).orderBy(asc(auditLogs.occurredAt), asc(auditLogs.id)),
  );
  return rows.map((r) => r.action).filter((a) => a.startsWith("member."));
}

describe("invite and accept", () => {
  it("the invited person joins with the role; the link then stops working", async () => {
    const shop = await newShop("Join");
    const staff = await registerVerifiedUser("Joining Cashier");
    const token = await invite(shop.ctx, staff.email);

    const listed = await listStaff(shop.ctx);
    expect(listed.invitations).toEqual([
      { id: expect.any(String) as unknown, email: staff.email, roleName: "Cashier", expiresAt: expect.any(String) as unknown, expired: false },
    ]);
    expect((await getPlanUsage(shop.ctx))?.usage[1]).toEqual({ resource: "users", used: 2, limit: 10 });

    expect(await acceptInvitation(staff.headers, { token })).toEqual({ tenantId: shop.ctx.tenantId });
    const joined = await getRequestContext(staff.headers);
    expect(joined.kind === "member" ? joined.roleName : joined.kind).toBe("Cashier");
    // Counted once, not twice.
    expect((await getPlanUsage(shop.ctx))?.usage[1]).toEqual({ resource: "users", used: 2, limit: 10 });
    expect((await listStaff(shop.ctx)).invitations).toEqual([]);
    expect(await auditActions(shop.ctx)).toEqual(["member.invited", "member.joined"]);

    expect(await codeOf(acceptInvitation(staff.headers, { token }))).toBe("INVITATION_INVALID");
  });

  it("the email shows the business and role and is valid 7 days; only a hash of the secret is stored", async () => {
    const shop = await newShop("Mail");
    const token = await invite(shop.ctx, "Mixed.Case@Test.Invalid");
    const mail = [...sentTestEmails()].reverse().find((m) => m.to === "mixed.case@test.invalid");
    expect(mail?.subject).toBe("You are invited to join Mail Shop");
    expect(mail?.text).toContain("as Cashier");
    expect(mail?.text).toContain("within 7 days");

    const rows = await withTenant(shop.ctx, (tx) =>
      tx.select({ email: invitations.email, tokenHash: invitations.tokenHash, expiresAt: invitations.expiresAt }).from(invitations),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("mixed.case@test.invalid");
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(token);
    const days = ((rows[0]?.expiresAt.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
  });

  it("a double click joins once", async () => {
    const shop = await newShop("Double");
    const staff = await registerVerifiedUser("Double Clicker");
    const token = await invite(shop.ctx, staff.email);
    const results = await Promise.all([
      codeOf(acceptInvitation(staff.headers, { token })),
      codeOf(acceptInvitation(staff.headers, { token })),
    ]);
    expect(results.sort()).toEqual(["INVITATION_INVALID", "ok"]);
    const members = await withTenant(shop.ctx, (tx) => tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, staff.userId)));
    expect(members).toHaveLength(1);
  });
});

describe("a link that must not work", () => {
  it("for another account (not the invited email), and the invitation stays open", async () => {
    const shop = await newShop("Wrong Account");
    const invited = await registerVerifiedUser("Invited Person");
    const other = await registerVerifiedUser("Link Thief");
    const token = await invite(shop.ctx, invited.email);
    expect(await codeOf(acceptInvitation(other.headers, { token }))).toBe("INVITATION_INVALID");
    expect((await getRequestContext(other.headers)).kind).toBe("no-business");
    expect(await codeOf(acceptInvitation(invited.headers, { token }))).toBe("ok");
  });

  it("without a login", async () => {
    const shop = await newShop("No Login");
    const token = await invite(shop.ctx, "nobody-yet@test.invalid");
    expect(await codeOf(acceptInvitation(new Headers(), { token }))).toBe("NOT_LOGGED_IN");
  });

  it("a made-up or malformed token", async () => {
    const someone = await registerVerifiedUser("Guesser");
    expect(await codeOf(acceptInvitation(someone.headers, { token: "a".repeat(43) }))).toBe("INVITATION_INVALID");
    expect(await codeOf(acceptInvitation(someone.headers, { token: "short" }))).toBe("INVITATION_INVALID");
    expect(await codeOf(acceptInvitation(someone.headers, { token: 42 }))).toBe("INVITATION_INVALID");
  });

  it("after it expired", async () => {
    const shop = await newShop("Expired");
    const staff = await registerVerifiedUser("Late Person");
    const token = await invite(shop.ctx, staff.email);
    await withTenant(shop.ctx, (tx) => tx.update(invitations).set({ expiresAt: sql`now() - interval '1 second'` }));
    expect(await codeOf(acceptInvitation(staff.headers, { token }))).toBe("INVITATION_EXPIRED");
    expect((await listStaff(shop.ctx)).invitations[0]?.expired).toBe(true);
  });

  it("after it was withdrawn; withdrawing twice is refused", async () => {
    const shop = await newShop("Revoked");
    const staff = await registerVerifiedUser("Unwanted");
    const token = await invite(shop.ctx, staff.email);
    const invitationId = (await listStaff(shop.ctx)).invitations[0]?.id ?? "";
    await revokeInvitation(shop.ctx, { invitationId });
    expect(await codeOf(acceptInvitation(staff.headers, { token }))).toBe("INVITATION_INVALID");
    expect(await codeOf(revokeInvitation(shop.ctx, { invitationId }))).toBe("NOT_PENDING");
    expect(await auditActions(shop.ctx)).toEqual(["member.invited", "member.invitation_revoked"]);
  });

  it("after a new invitation to the same address replaced it (only the new link works)", async () => {
    const shop = await newShop("Resend");
    const staff = await registerVerifiedUser("Resent Person");
    const first = await invite(shop.ctx, staff.email);
    const second = await invite(shop.ctx, staff.email, "Manager");
    expect(first).not.toBe(second);
    expect((await listStaff(shop.ctx)).invitations).toHaveLength(1);
    expect(await codeOf(acceptInvitation(staff.headers, { token: first }))).toBe("INVITATION_INVALID");
    expect(await codeOf(acceptInvitation(staff.headers, { token: second }))).toBe("ok");
    const joined = await getRequestContext(staff.headers);
    expect(joined.kind === "member" ? joined.roleName : joined.kind).toBe("Manager");
  });

  it("for someone who already has a business", async () => {
    const shop = await newShop("Taken");
    const other = await newShop("Other Owner");
    const token = await invite(shop.ctx, other.owner.email);
    expect(await codeOf(acceptInvitation(other.owner.headers, { token }))).toBe("ALREADY_IN_A_BUSINESS");
  });
});

describe("what can be invited", () => {
  it("not the owner role, not another business's role, not an existing member", async () => {
    const shop = await newShop("Rules");
    const other = await newShop("Other Rules");
    expect(await codeOf(inviteStaff(shop.ctx, { email: "x@test.invalid", roleId: await roleId(shop.ctx, "Owner") }))).toBe("CANNOT_ASSIGN_OWNER");
    expect(await codeOf(inviteStaff(shop.ctx, { email: "x@test.invalid", roleId: await roleId(other.ctx, "Cashier") }))).toBe("ROLE_NOT_FOUND");
    expect(await codeOf(inviteStaff(shop.ctx, { email: shop.owner.email.toUpperCase(), roleId: await roleId(shop.ctx, "Cashier") }))).toBe("ALREADY_MEMBER");
  });

  it("refuses a bad email or extra fields", async () => {
    const shop = await newShop("Input");
    const cashier = await roleId(shop.ctx, "Cashier");
    await expect(inviteStaff(shop.ctx, { email: "not-an-email", roleId: cashier })).rejects.toThrow();
    await expect(inviteStaff(shop.ctx, { email: "ok@test.invalid", roleId: cashier, tenantId: shop.ctx.tenantId })).rejects.toThrow();
    expect((await listStaff(shop.ctx)).invitations).toEqual([]);
  });

  it("open invitations count against the staff limit (pilot: 10 including the owner)", async () => {
    const shop = await newShop("Full");
    for (let i = 0; i < 9; i++) await invite(shop.ctx, `staff-${String(i)}-${shop.ctx.tenantId}@test.invalid`);
    expect(await codeOf(invite(shop.ctx, `one-too-many-${shop.ctx.tenantId}@test.invalid`))).toBe("LIMIT_REACHED");
    // Withdrawing one frees a place.
    const first = (await listStaff(shop.ctx)).invitations[0]?.id ?? "";
    await revokeInvitation(shop.ctx, { invitationId: first });
    expect(await codeOf(invite(shop.ctx, `now-fits-${shop.ctx.tenantId}@test.invalid`))).toBe("ok");
    // 11 invitations one after another: about 27 s on the remote test
    // database, too close to the default 30 s.
  }, 90_000);
});

describe("who may manage staff", () => {
  it.each(["Manager", "Cashier", "Accountant"])("%s may not list, invite or withdraw", async (role) => {
    const shop = await newShop(`Staff ${role}`);
    const user = await registerVerifiedUser(`Staff ${role}`);
    const token = await invite(shop.ctx, user.email, role);
    await acceptInvitation(user.headers, { token });
    const ctx = await memberCtx(user.headers);
    expect(await codeOf(listStaff(ctx))).toBe("FORBIDDEN");
    expect(await codeOf(inviteStaff(ctx, { email: "friend@test.invalid", roleId: await roleId(shop.ctx, "Admin") }))).toBe("FORBIDDEN");
    expect(await codeOf(revokeInvitation(ctx, { invitationId: "00000000-0000-4000-8000-000000000000" }))).toBe("FORBIDDEN");
  });

  it("an Admin may invite", async () => {
    const shop = await newShop("Admin Invites");
    const admin = await registerVerifiedUser("Inviting Admin");
    await acceptInvitation(admin.headers, { token: await invite(shop.ctx, admin.email, "Admin") });
    const ctx = await memberCtx(admin.headers);
    expect(await codeOf(inviteStaff(ctx, { email: "new-one@test.invalid", roleId: await roleId(shop.ctx, "Cashier") }))).toBe("ok");
  });

  it("another business's invitation cannot be withdrawn", async () => {
    const a = await newShop("Inv A");
    const b = await newShop("Inv B");
    await invite(b.ctx, `b-staff-${b.ctx.tenantId}@test.invalid`);
    const bInvitation = (await listStaff(b.ctx)).invitations[0]?.id ?? "";
    expect(await codeOf(revokeInvitation(a.ctx, { invitationId: bInvitation }))).toBe("NOT_FOUND");
    expect((await listStaff(b.ctx)).invitations).toHaveLength(1);
  });
});
