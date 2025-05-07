import express, { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticatedUser } from '../utils/session';
import { prisma } from '../utils/config.auth';

const router = express.Router();

router.get('/profile', authenticatedUser, async (req: Request, res: Response) => {
  try {
    const authUser = req.res!.locals.authUser!; // Non-null assertion as middleware guarantees it

    const user = await prisma.user.findUnique({
      where: { email: authUser.email! }, // Use email from authUser
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /users/profile - met à jour le nom de l'utilisateur connecté
router.put('/profile', authenticatedUser, async (req, res) => {
  try {
    const authUser = req.res!.locals.authUser!; // Non-null assertion

    const { name } = req.body;
    if (typeof name !== 'string') {
      return res.status(400).json({ message: 'Name must be a string.' });
    }
    const updatedUser = await prisma.user.update({
      where: { email: authUser.email! }, // Use email from authUser
      data: { name },
      select: {
        id: true,
        email: true,
        name: true,
        updatedAt: true,
      },
    });
    res.json({
      message: 'Profile updated successfully',
      user: updatedUser,
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

export { router };

