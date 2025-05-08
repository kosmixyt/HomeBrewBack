import { Router } from "express";
import { containersRouter } from "./containers";
import { imagesRouter } from "./images";

export const router = Router();

router.use('/containers', containersRouter);
router.use('/images', imagesRouter);
