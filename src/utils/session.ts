import { getSession } from "@auth/express";
import express, { NextFunction } from "express";
import { authConfig } from "./config.auth";
export async function authenticatedUser(
  req: express.Request,
  res: express.Response,
  next: NextFunction
) {
  const session = res.locals.session ?? (await getSession(req, authConfig));
  if (!session?.user) {
    res.redirect("/login");
  } else {
    next();
  }
}
