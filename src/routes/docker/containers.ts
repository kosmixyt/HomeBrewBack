import { Router, Request, Response, NextFunction } from 'express';
import { getSession } from '@auth/express';
import { authConfig, prisma } from '../../utils/config.auth';
import { SshConnectionManager } from '../../ws/SshConnectionManager';
import { SshCredential } from '@prisma/client';
import { router } from './router';
import { parseDockerRun } from '../../utils/dockerRunParser';

export const containersRouter = Router();

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
containersRouter.get('/:credentialId', ensureAuthenticated, async (req: Request, res: Response) => {
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

// POST /:credentialId/containers/:containerId/start - Start a Docker container
containersRouter.post('/:credentialId/:containerId/start', ensureAuthenticated, async (req: Request, res: Response) => {
    const { credentialId, containerId } = req.params;
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
        const container = docker.getContainer(containerId);
        await container.start();
        res.status(200).json({ message: 'Container started successfully.' });
    } catch (error: any) {
        console.error(`[DockerRoute] Error starting container ${containerId} for ${credentials.host}:`, error);
        res.status(500).json({ error: 'Failed to start container.', details: error.message });
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

// POST /:credentialId/containers/:containerId/stop - Stop a Docker container
containersRouter.post('/:credentialId/:containerId/stop', ensureAuthenticated, async (req: Request, res: Response) => {
    const { credentialId, containerId } = req.params;
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
        const container = docker.getContainer(containerId);
        await container.stop();
        res.status(200).json({ message: 'Container stopped successfully.' });
    } catch (error: any) {
        console.error(`[DockerRoute] Error stopping container ${containerId} for ${credentials.host}:`, error);
        res.status(500).json({ error: 'Failed to stop container.', details: error.message });
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

// DELETE /:credentialId/containers/:containerId - Delete a Docker container
containersRouter.delete('/:credentialId/:containerId', ensureAuthenticated, async (req: Request, res: Response) => {
    const { credentialId, containerId } = req.params;
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
        const container = docker.getContainer(containerId);
        
        // Optionnel: s'assurer que le conteneur est arrêté avant de le supprimer
        // Vous pouvez inspecter l'état et l'arrêter si nécessaire, ou utiliser l'option force
        // await container.stop().catch(() => {}); // Tenter d'arrêter, ignorer l'erreur si déjà arrêté

        await container.remove({ force: true }); // force: true pour supprimer même s'il est en cours d'exécution (à utiliser avec prudence)
        res.status(200).json({ message: 'Container removed successfully.' });
    } catch (error: any) {
        console.error(`[DockerRoute] Error removing container ${containerId} for ${credentials.host}:`, error);
        res.status(500).json({ error: 'Failed to remove container.', details: error.message });
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

// POST /:credentialId/containers/create - Create a container from a docker run command
containersRouter.post('/:credentialId/create', ensureAuthenticated, async (req: Request, res: Response) => {
    const { credentialId } = req.params;
    const { containerConfig } = req.body;
    // @ts-ignore
    const userId = req.user.id as string;

    if (!containerConfig) {
        return res.status(400).json({ error: 'Container configuration is required.' });
    }

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
        
        // Create the container with the provided configuration
        const container = await docker.createContainer(containerConfig);
        
        // Optionally start the container immediately if requested
        if (req.body.start) {
            await container.start();
        }
        
        // Return the container information
        const containerInfo = await container.inspect();
        res.status(201).json({
            message: 'Container created successfully.',
            container: containerInfo
        });
    } catch (error: any) {
        console.error(`[DockerRoute] Error creating container for ${credentials.host}:`, error);
        res.status(500).json({ 
            error: 'Failed to create container.',
            details: error.message 
        });
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

// POST /:credentialId/containers/compose - Create containers from a docker-compose file
containersRouter.post('/:credentialId/compose', ensureAuthenticated, async (req: Request, res: Response) => {
    const { credentialId } = req.params;
    const { composeConfig } = req.body;
    // @ts-ignore
    const userId = req.user.id as string;

    if (!composeConfig) {
        return res.status(400).json({ error: 'Docker Compose configuration is required.' });
    }

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
        
        // Exécuter docker-compose via SSH est plus complexe car Docker API n'a pas de support direct pour docker-compose
        // Nous allons exécuter une commande SSH pour faire cela
        
        // Cette partie nécessite un client SSH établi avec les mêmes credentials
        // Nous sauvegardons d'abord le contenu du docker-compose dans un fichier temporaire sur le serveur distant
        // puis nous exécutons la commande docker-compose up
        
        // Pour cette version simplifiée, nous renvoyons une réponse avec un message indiquant que cette fonctionnalité est en cours de développement
        // Dans une implémentation réelle, vous voudriez :
        // 1. Sauvegarder le fichier docker-compose.yml sur le serveur distant
        // 2. Exécuter la commande docker-compose up
        // 3. Capturer la sortie et les erreurs
        // 4. Renvoyer les résultats
        
        res.status(200).json({
            message: 'Docker Compose received. This functionality is available through SSH terminal only.',
            // Dans une implémentation réelle, vous renverriez également les détails des conteneurs créés
        });
    } catch (error: any) {
        console.error(`[DockerRoute] Error with docker-compose for ${credentials.host}:`, error);
        res.status(500).json({ 
            error: 'Failed to execute docker-compose.',
            details: error.message 
        });
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

// POST /parse-docker-run - Parse docker run command to container config
containersRouter.post('/parse-docker-run', ensureAuthenticated, async (req: Request, res: Response) => {
    const { command } = req.body;
    
    if (!command) {
        return res.status(400).json({ error: 'Docker run command is required.' });
    }
    
    try {
        const containerConfig = parseDockerRun(command);
        res.status(200).json({
            message: 'Command parsed successfully.',
            containerConfig
        });
    } catch (error: any) {
        console.error(`[DockerRoute] Error parsing docker run command:`, error);
        res.status(400).json({ 
            error: 'Failed to parse docker run command.',
            details: error.message 
        });
    }
});

