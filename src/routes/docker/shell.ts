import { Router } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { SshConnectionManager } from '../../ws/SshConnectionManager';
import { prisma, authConfig } from '../../utils/config.auth';
import { getSessionFromRequest } from '../../utils/session';

// Export a function to set up the Docker shell WebSocket
export function setupDockerShellSocket(io: SocketIOServer) {
  // Create a namespace for Docker container shells
  const dockerShell = io.of('/docker-shell');

  dockerShell.on('connection', async (socket) => {
    
    console.log(`[DockerShell] New socket connection: ${socket.id}`);

    // Authenticate the user
    const session = await getSessionFromRequest(socket.request);
    if (!session) {
      console.log(`[DockerShell] Socket ${socket.id} not authenticated`);
      socket.emit('error', 'Unauthorized access. Please log in.');
      socket.disconnect();
      return;
    }

    console.log(`[DockerShell] Socket ${socket.id} authenticated`);

    // Get container ID and credential ID from socket connection parameters
    const { credentialId, containerId } = socket.handshake.query;

    if (!credentialId || !containerId) {
      console.log(`[DockerShell] Missing required parameters for socket ${socket.id}`);
      socket.emit('error', 'Missing required parameters (credentialId or containerId)');
      socket.disconnect();
      return;
    }

    // Verify the user has access to this SSH credential
    try {
      const credentials = await prisma.sshCredential.findUnique({
        where: {
          id: credentialId as string,
          AND: {
            User: {
              // @ts-ignore - We know user exists and has an id because we checked session exists
              id: session.user?.id,
            }
          }
        }
      });

      if (!credentials) {
        console.log(`[DockerShell] Invalid credentials for socket ${socket.id}`);
        socket.emit('error', 'Invalid SSH credentials or permission denied.');
        socket.disconnect();
        return;
      }

      console.log(`[DockerShell] Socket ${socket.id} authenticated for container ${containerId} on ${credentials.host}`);

      // Get Docker connection
      const manager = SshConnectionManager.getInstance();
      const docker = await manager.getDockerode(credentials);

      // Verify the container exists and is running
      let container;
      try {
        container = docker.getContainer(containerId as string);
        const containerInfo = await container.inspect();
        
        if (!containerInfo.State.Running) {
          socket.emit('error', 'Container is not running.');
          socket.disconnect();
          return;
        }
      } catch (error) {
        console.error(`[DockerShell] Error getting container ${containerId}:`, error);
        socket.emit('error', 'Failed to access container.');
        socket.disconnect();
        return;
      }

      // Signal client that the backend is ready for shell-init
      socket.emit('container-ready-for-shell-init');
      console.log(`[DockerShell] Emitted 'container-ready-for-shell-init' for socket ${socket.id}`);

      // Set up the exec instance to run a shell inside the container
      socket.on('shell-init', async (data: { cols: number, rows: number }) => {
        try {
          console.log(`[DockerShell] Creating exec instance for container ${containerId}`);
          
          const exec = await container.exec({
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
            Cmd: ['/bin/sh'],
          });

          const stream = await exec.start({
            Tty: true,
            stdin: true,
            hijack: true
          });

          // Set the terminal size
          if (data && data.cols && data.rows) {
            await exec.resize({ h: data.rows, w: data.cols });
          }

          // Stream data from container to client
          stream.on('data', (chunk) => {
            console.log(`[DockerShell] Received data from container: ${chunk.toString()}`);
            socket.emit('output', chunk.toString());
          });

          // NOUVEAU: Gestionnaire d'erreur pour le stream
          stream.on('error', (err) => {
            console.error('[DockerShell] Stream ERROR:', err);
            socket.emit('output', `\\r\\nStream Error from container: ${err.message}\\r\\n`);
            // Vous pourriez envisager de fermer la connexion ici si une erreur de stream se produit
            // socket.emit('exit');
            // socket.disconnect(true);
          });

          // NOUVEAU: Gestionnaire de fermeture pour le stream
          stream.on('close', () => {
            // Cet événement est émis lorsque le stream et ses ressources sous-jacentes sont fermés.
            console.log('[DockerShell] Stream CLOSED (from container side).');
            socket.emit('output', '\\r\\nShell stream closed from container side.\\r\\n');
            // Le gestionnaire 'end' existant déconnecte déjà le socket,
            // cela peut être complémentaire ou indiquer la même fin de processus.
          });

          // Handle stream end (lorsque stdout/stderr du processus conteneur se termine)
          stream.on('end', () => {
            console.log('[DockerShell] Stream ENDED (container process likely exited).');
            socket.emit('output', '\\r\\nShell stream ended.\\r\\n');
            socket.emit('exit');
            socket.disconnect(true);
          });

          // Stream data from client to container
          socket.on('input', (data) => {
            console.log(`[DockerShell] Sending data to container: ${data}`);
            stream.write(data);
          });

          // Handle resize events
          socket.on('resize', async (data: { cols: number, rows: number }) => {
            try {
              await exec.resize({ h: data.rows, w: data.cols });
            } catch (error) {
              console.error(`[DockerShell] Error resizing terminal:`, error);
            }
          });

          // When socket disconnects, clean up
          socket.on('disconnect', () => {
            console.log(`[DockerShell] Socket ${socket.id} disconnected`);
            try {
              stream.end();
              manager.releaseUsage(credentials);
            } catch (error) {
              console.error('[DockerShell] Error during cleanup:', error);
            }
          });

          socket.emit('ready');
          console.log(`[DockerShell] Shell ready for container ${containerId}`);
        } catch (error) {
          console.error(`[DockerShell] Error creating shell for container ${containerId}:`, error);
          socket.emit('error', 'Failed to create shell in container.');
          socket.disconnect();
          manager.releaseUsage(credentials);
        }
      });
    } catch (error) {
      console.error(`[DockerShell] Error setting up shell for socket ${socket.id}:`, error);
      socket.emit('error', 'Failed to set up shell connection.');
      socket.disconnect();
    }
  });
}

// Create a router to expose any HTTP endpoints if needed
export const shellRouter = Router();
