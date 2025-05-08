import { Router, Request, Response, NextFunction } from 'express';
import { getSession } from '@auth/express';
import { authConfig, prisma } from '../../utils/config.auth';
import { SshConnectionManager } from '../../ws/SshConnectionManager';
import { SshCredential } from '@prisma/client';

const router = Router();

// Middleware for authentication
const ensureAuthenticated = async (req: Request, res: Response, next: NextFunction) => {
    const session = await getSession(req, authConfig);
    if (!session || !session.user) {
        return res.status(401).json({ error: 'Unauthorized. Please log in.' });
    }
    // @ts-ignore
    req.user = session.user; // Attach user to request object
    next();
};

// GET /credentials/:credentialId/containers - List Docker containers for a given SSH credential
router.get('/:credentialId/containers', ensureAuthenticated, async (req: Request, res: Response) => {
    const { credentialId } = req.params;
    // @ts-ignore
    const userId = req.user.id as string;

    // Add request timeout handling
    let timeoutId: NodeJS.Timeout | null = setTimeout(() => {
        timeoutId = null;
        console.error(`[DockerRoute] Request for containers on credential ${credentialId} timed out after 30s`);
        res.status(504).json({ error: 'Request timed out while connecting to Docker.' });
    }, 30000); // 30 second timeout

    const SclearTimeout = () => {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
    };

    if (!credentialId) {
        SclearTimeout();
        return res.status(400).json({ error: 'Credential ID is required.' });
    }

    let credentials;
    try {
        console.log(`[DockerRoute] Fetching SSH credential ${credentialId} for user ${userId}`);
        credentials = await prisma.sshCredential.findUnique({
            where: {
                id: credentialId,
                userId: userId,
            },
        });

        if (!credentials) {
            SclearTimeout();
            return res.status(404).json({ error: 'SSH Credential not found or access denied.' });
        }

        console.log(`[DockerRoute] Found credential ${credentials.id} for ${credentials.host}`);
    } catch (error) {
        console.error('[DockerRoute] Error fetching SSH credentials:', error);
        SclearTimeout();
        return res.status(500).json({ error: 'Failed to retrieve SSH credentials.' });
    }

    const manager = SshConnectionManager.getInstance();

    try {
        console.log(`[DockerRoute] Getting Dockerode instance for ${credentials.host}`);
        const docker = await manager.getDockerode(credentials);

        console.log(`[DockerRoute] Listing containers for ${credentials.host}`);
        const containers = await docker.listContainers({ all: true });

        console.log(`[DockerRoute] Successfully retrieved ${containers.length} containers from ${credentials.host}`);
        SclearTimeout();
        res.json(containers);
    } catch (error: any) {
        console.error(`[DockerRoute] Error listing containers for ${credentials.host}:`, error);
        SclearTimeout();
        res.status(500).json({
            error: 'Failed to list Docker containers.',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    } finally {
        if (credentials) {
            try {
                manager.releaseUsage(credentials);
                console.log(`[DockerRoute] Released usage for credential ${credentials.id}`);
            } catch (e) {
                console.error(`[DockerRoute] Error releasing usage:`, e);
            }
        }
    }
});

export { router as dockerRouter };
