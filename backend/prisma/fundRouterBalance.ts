import { prisma } from "../src/lib/prisma";

// TEST HELPER — manually credit a user's router $ wallet.
// Usage: npx tsx prisma/fundRouterBalance.ts <email> <usd>
// (Real funding path via payments/admin is still TODO.)
async function main() {
  const [email, usd] = process.argv.slice(2);
  if (!email || !usd) { console.error("usage: tsx prisma/fundRouterBalance.ts <email> <usd>"); process.exit(1); }

  const user = await prisma.user.findUnique({ where: { email }, select: { clerkId: true } });
  if (!user) { console.error("no user with email", email); process.exit(1); }

  await prisma.userCredits.upsert({
    where: { userId: user.clerkId },
    update: { routerBalanceUsd: { increment: usd } },
    create: { userId: user.clerkId, credits: 0, routerBalanceUsd: usd },
  });
  const uc = await prisma.userCredits.findUnique({ where: { userId: user.clerkId }, select: { routerBalanceUsd: true } });
  console.log(`funded ${email} -> routerBalanceUsd = $${uc?.routerBalanceUsd}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
