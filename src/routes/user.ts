import express, { Request, Response} from 'express';
import { PrismaClient } from '@prisma/client';
import {  getSession } from '@auth/express';
import { authenticatedUser } from '../utils/session';
import { authConfig, prisma } from '../utils/config.auth';

const router = express.Router();

router.get('/profile', authenticatedUser, async (req : Request, res : Response) => {
  try {
    const session = await getSession(req, authConfig);
    if (!session?.user?.email) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
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
    const session = await getSession(req, authConfig);
    if (!session?.user?.email) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    const { name } = req.body;
    const updatedUser = await prisma.user.update({
      where: { email: session.user.email },
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

