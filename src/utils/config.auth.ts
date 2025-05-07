import { PrismaAdapter } from "@auth/prisma-adapter";
import { PrismaClient } from "@prisma/client";
import DiscordProvider from "next-auth/providers/discord";

export const prisma = new PrismaClient();

export const authConfig = {
  adapter: PrismaAdapter(prisma),
  providers: [
    // @ts-ignore
    (DiscordProvider.default || DiscordProvider)({
      clientId: process.env.DISCORD_CLIENT_ID as string,
      clientSecret: process.env.DISCORD_CLIENT_SECRET as string,
    }),
  ],
  callbacks: {
    // @ts-ignore
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        session.user.email = user.email; // Ensure email is on session.user
        session.user.name = user.name;   // Ensure name is on session.user
      }
      return session;
    },
  },
};