import { getSession } from "@auth/express";
import http from "http";
import express, { NextFunction, Request as ExpressRequest } from 'express';
import { authConfig, prisma } from "./config.auth"; // Import prisma
import tls from "tls";
import { Session } from "next-auth";
import { User } from "@prisma/client"; // Import User type

// Extend Express's Response.Locals type to include dbUser, authUser, and session
declare global {
  namespace Express {
    interface Locals {
      dbUser?: User;
      authUser?: { id: string; name?: string | null; email?: string | null; image?: string | null;[key: string]: any }; // User from Auth.js session
      session?: Session; // The whole session object
    }
  }
}

export async function authenticatedUser(
  req: express.Request,
  res: express.Response,
  next: NextFunction
) {
  const session = await getSession(req, authConfig);

  if (!session?.user?.email) {
    // For API routes, send a 401 Unauthorized status
    return res.status(401).json({ message: 'Authentication required. Invalid or missing session.' });
  }

  res.locals.session = session;
  // Type assertion needed as session.user can be broader; callback ensures these fields.
  res.locals.authUser = session.user as { id: string; name?: string | null; email: string; image?: string | null };

  try {
    const dbUser = await prisma.user.findUnique({
      where: { email: session.user.email }, // Use email from session
    });

    if (!dbUser) {
      console.error(`User with email ${session.user.email} from session not found in database.`);
      return res.status(401).json({ message: 'Authenticated user not found in database.' });
    }
    res.locals.dbUser = dbUser;
    next();
  } catch (error) {
    console.error("Error fetching user from database in middleware:", error);
    return res.status(500).json({ message: 'Server error while verifying user.' });
  }
}

export async function getSessionFromRequest(
  req: http.IncomingMessage
): Promise<Session | null> {
  const { headers } = req;
  const host = headers.host;
  let protocol = 'http';
  if ((req.connection as tls.TLSSocket).encrypted) {
    protocol = 'https';
  }

  const forwardedProtoHeader = headers['x-forwarded-proto'];
  if (typeof forwardedProtoHeader === 'string') {
    protocol = forwardedProtoHeader.split(',')[0].trim();
  }
  const mockExpressRequest = {
    headers: headers, // Provides req.headers.cookie for getSession
    protocol: protocol, // Provides req.protocol for getSession
    get: (name: string): string | undefined => { // Provides req.get(name) for getSession
      if (name.toLowerCase() === 'host') {
        return host;
      }
      // Express's req.get() also normalizes other header names to lowercase.
      // This simplified version covers 'host' and direct lowercase access.
      return headers[name.toLowerCase()] as string | undefined;
    },
    // Add other Express.Request properties if getSession implementation were to need them.
    // Based on @auth/express source, `req.protocol`, `req.get("host")`,
    // and `req.headers.cookie` are the primary needs.
  } as ExpressRequest; // Type assertion to satisfy getSession's parameter type
  const session = await getSession(mockExpressRequest, authConfig);
  return session;
}