import { prisma } from "../lib/prisma";
export async function getUserId(clerkId: string) {
  try {
    const user = await prisma.user.findUnique({
      where: {
        clerkId: clerkId,
      },
      select: {
        id: true,
      },
    });
    if (!user?.id) throw new Error("User Not Found");
    return user?.id;
  } catch (error) {
    return null;
  }
}
