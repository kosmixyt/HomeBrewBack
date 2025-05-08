import { Router, Request, Response, NextFunction } from 'express';
import { getSession } from '@auth/express';
import { authConfig, prisma } from '../../utils/config.auth';
import { SshConnectionManager } from '../../ws/SshConnectionManager';
import { SshCredential } from '@prisma/client';
import { router } from './router';


export const imagesRouter = Router();
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

// GET /images - List Docker images for a given SSH credential
imagesRouter.get('/:credentialId', ensureAuthenticated, async (req: Request, res: Response) => {
    const { credentialId } = req.params;
    // @ts-ignore
    const userId = req.user.id as string;

    // Add request timeout handling
    let timeoutId: NodeJS.Timeout | null = setTimeout(() => {
        timeoutId = null;
        console.error(`[DockerRoute] Request for images on credential ${credentialId} timed out after 30s`);
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

        console.log(`[DockerRoute] Listing images for ${credentials.host}`);
        const images = await docker.listImages({ all: true });

        console.log(`[DockerRoute] Successfully retrieved ${images.length} images from ${credentials.host}`);
        SclearTimeout();
        res.json(images);
    } catch (error: any) {
        console.error(`[DockerRoute] Error listing images for ${credentials.host}:`, error);
        SclearTimeout();
        res.status(500).json({
            error: 'Failed to list Docker images.',
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

// DELETE /:credentialId/images/:imageId - Delete a Docker image
imagesRouter.delete('/:credentialId/:imageId', ensureAuthenticated, async (req: Request, res: Response) => {
    const { credentialId, imageId } = req.params;
    // @ts-ignore
    const userId = req.user.id as string;

    let credentials;
    try {
        credentials = await prisma.sshCredential.findUnique({
            where: { id: credentialId, userId: userId },
        });
        if (!credentials) {
            return res.status(404).json({ error: 'SSH Credential not found or access denied.' });
        }
    } catch (error) {
        return res.status(500).json({ error: 'Failed to retrieve SSH credentials.' });
    }

    const manager = SshConnectionManager.getInstance();
    try {
        const docker = await manager.getDockerode(credentials);
        const image = docker.getImage(imageId); // imageId peut être l'ID long ou court, ou un nom de tag
        
        await image.remove({ force: false }); // force: false par défaut, ne supprime pas si des conteneurs l'utilisent. Mettre à true pour forcer.
        res.status(200).json({ message: 'Image removed successfully.' });
    } catch (error: any) {
        console.error(`[DockerRoute] Error removing image ${imageId} for ${credentials.host}:`, error);
        // Dockerode renvoie souvent un 404 si l'image n'existe pas, ou 409 si elle est utilisée.
        if (error.statusCode === 404) {
            return res.status(404).json({ error: 'Image not found.', details: error.message });
        } else if (error.statusCode === 409) {
            return res.status(409).json({ error: 'Image is in use by one or more containers.', details: error.message });
        }
        res.status(500).json({ error: 'Failed to remove image.', details: error.message });
    } finally {
        if (credentials) {
            try {
                manager.releaseUsage(credentials);
            } catch (e) {
                console.error(`[DockerRoute] Error releasing usage:`, e);
            }
        }
    }
});

