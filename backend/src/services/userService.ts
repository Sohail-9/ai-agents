import { prisma } from '../lib/prisma';

export const userService = {
  // Create or update a user
  createOrUpdateUser: async (userData: {
    clerkId: string;
    email?: string;
    name?: string;
    image?: string;
  }) => {
    const { clerkId, email, name, image } = userData;
    
    try {
      // Check if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { clerkId }
      });

      if (existingUser) {
        // Update existing user
        return await prisma.user.update({
          where: { clerkId },
          data: {
            email,
            name,
            image,
          },
        });
      } else {
        // Create new user and UserCredits in transaction
        return await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              clerkId,
              email,
              name,
              image,
            },
          });
          // Create UserCredits — new users start with 1000 credits ($1 = 1 credit).
          await tx.userCredits.create({
            data: {
              userId: clerkId,
              credits: 1000,
            },
          });
          return user;
        });
      }
    } catch (error) {
      console.error('[Prisma] createOrUpdateUser failed:', error);
      throw error;
    }
  },

  // Provision a user from AI Agents auth-service identity on first authenticated
  // request (replaces the Clerk user.created webhook). Upserts on the clerkId
  // column (now holds the auth-service UUID) and seeds UserCredits in the same
  // transaction — preserving createOrUpdateUser credit semantics.
  provisionUser: async (data: {
    authUserId: string;
    email?: string;
    name?: string;
    image?: string;
  }) => {
    const { authUserId, email, name, image } = data;
    try {
      const byClerk = await prisma.user.findUnique({
        where: { clerkId: authUserId },
      });
      // Row that currently owns this email, if any (email is @unique).
      const byEmail = email
        ? await prisma.user.findUnique({ where: { email } })
        : null;

      if (byClerk) {
        // Already provisioned under this auth id. Only write email when it is
        // free or already ours — otherwise a different row owns it and writing
        // it would trip the unique constraint (the P2002 we're fixing).
        const emailIsSafe = !byEmail || byEmail.clerkId === authUserId;
        if (!emailIsSafe) {
          console.warn(
            `[provisionUser] email ${email} owned by clerkId ${byEmail!.clerkId}, ` +
              `not ${authUserId}; updating name/image only to avoid unique clash`
          );
        }
        return await prisma.user.update({
          where: { clerkId: authUserId },
          data: emailIsSafe ? { email, name, image } : { name, image },
        });
      }

      // No row for this auth id yet. If a legacy row (e.g. Clerk-era) already
      // holds this email, reattach it to the auth-service id instead of
      // creating a duplicate. FK columns referencing User.clerkId cascade on
      // update (Prisma default onUpdate: Cascade), so child rows follow.
      if (byEmail) {
        console.warn(
          `[provisionUser] reattaching existing row (email ${email}, old clerkId ` +
            `${byEmail.clerkId}) to auth id ${authUserId}`
        );
        return await prisma.user.update({
          where: { id: byEmail.id },
          data: { clerkId: authUserId, name, image },
        });
      }

      return await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { clerkId: authUserId, email, name, image },
        });
        await tx.userCredits.create({ data: { userId: authUserId, credits: 1000 } });
        return user;
      });
    } catch (error) {
      console.error('[Prisma] provisionUser failed:', error);
      throw error;
    }
  },

  // Get user by Clerk ID
  getUser: async (clerkId: string) => {
    try {
      return await prisma.user.findUnique({
        where: { clerkId },
      });
    } catch (error) {
      console.error('[Prisma] getUser failed:', error);
      throw error;
    }
  },

};