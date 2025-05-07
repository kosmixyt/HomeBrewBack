import { getSession } from '@auth/express';
import express from 'express';
import { authConfig, prisma } from '../../utils/config.auth'; // Assuming prisma is exported from config.auth or import directly
import { SshConnectionManager } from '../../ws/SshConnectionManager';

const sshRouter = express.Router();

// GET all SSH credentials for the logged-in user
sshRouter.get('/', async (req, res) => {
    const session = await getSession(req, authConfig);
    if (!session || !session.user || !session.user.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const credentials = await prisma.sshCredential.findMany({
            select: {
                id: true,
                host: true,
                username: true,
                name: true,
            },
            where: {
                userId: session.user.id,
            },
        });
        res.json(credentials);
    } catch (error) {
        console.error('Error fetching SSH credentials:', error);
        res.status(500).json({ error: 'Failed to fetch SSH credentials' });
    }
});

// POST a new SSH credential
sshRouter.post('/', async (req, res) => {
    const session = await getSession(req, authConfig);
    if (!session || !session.user || !session.user.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { host, port, username, password, name } = req.body;

    if (!host || !port || !username || !name || !password) { // Password can be optional if using key-based auth later
        return res.status(400).json({ error: 'Missing required fields (host, port, username, name)' });
    }

    try {
        const newCredential = await prisma.sshCredential.create({
            data: {
                userId: session.user.id,
                host,
                port: parseInt(port, 10),
                username,
                password: password, // Store empty string if password not provided
                name,
            },
        });
        res.status(201).json(newCredential);
    } catch (error) {
        console.error('Error creating SSH credential:', error);
        if (error instanceof Error && error.message.includes('Unique constraint failed')) {
            return res.status(409).json({ error: 'An SSH credential with similar details might already exist.' });
        }
        res.status(500).json({ error: 'Failed to create SSH credential' });
    }
});

// DELETE an SSH credential
sshRouter.delete('/:id', async (req, res) => {
    const session = await getSession(req, authConfig);
    if (!session || !session.user || !session.user.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;

    try {
        const credentialToDelete = await prisma.sshCredential.findUnique({
            where: { id },
        });

        if (!credentialToDelete) {
            return res.status(404).json({ error: 'Credential not found' });
        }

        if (credentialToDelete.userId !== session.user.id) {
            return res.status(403).json({ error: 'Forbidden: You do not own this credential' });
        }



        SshConnectionManager.clearConnection(credentialToDelete); // Clear any existing connections
        await prisma.sshCredential.delete({
            where: {
                id: id,
            },
        });
        res.status(204).send(); // No content
    } catch (error) {
        console.error('Error deleting SSH credential:', error);
        res.status(500).json({ error: 'Failed to delete SSH credential' });
    }
});

export { sshRouter };
