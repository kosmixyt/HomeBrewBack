import { Server as SocketIOServer, Socket } from 'socket.io';
import { SshConnectionManager } from '../../ws/SshConnectionManager';
import { prisma } from '../../utils/config.auth';
import { getSessionFromRequest } from '../../utils/session';
import Dockerode from 'dockerode'; // Import Dockerode itself

// Define a simpler interface if DockerContainer is not directly available
interface MyDockerContainer {
  inspect(): Promise<any>;
  logs(options: Dockerode.ContainerLogsOptions): Promise<NodeJS.ReadableStream>;
  // Add other methods if needed
}

export function setupDockerLogsSocket(io: SocketIOServer) {
  const dockerLogsNamespace = io.of('/docker-logs');

  dockerLogsNamespace.on('connection', async (socket: Socket) => {
    console.log(`[DockerLogs] New socket connection: ${socket.id}`);

    const session = await getSessionFromRequest(socket.request);
    if (!session || !session.user) {
      socket.emit('error', 'Unauthorized access. Please log in.');
      socket.disconnect();
      return;
    }

    const { credentialId, containerId } = socket.handshake.query;

    if (!credentialId || !containerId || typeof credentialId !== 'string' || typeof containerId !== 'string') {
      socket.emit('error', 'Missing or invalid required parameters (credentialId or containerId)');
      socket.disconnect();
      return;
    }

    let currentCredentials: any; // Type it properly if you have the SshCredential type available
    let docker: Dockerode;
    let containerToLog: MyDockerContainer | null = null;
    let logStream: NodeJS.ReadableStream | null = null;
    const manager = SshConnectionManager.getInstance();

    try {
      currentCredentials = await prisma.sshCredential.findUnique({
        where: {
          id: credentialId,
          // @ts-ignore
          userId: session.user.id, 
        },
      });

      if (!currentCredentials) {
        socket.emit('error', 'SSH Credential not found or access denied.');
        socket.disconnect();
        return;
      }

      docker = await manager.getDockerode(currentCredentials);
      // Cast to MyDockerContainer to use our simplified interface
      containerToLog = docker.getContainer(containerId) as MyDockerContainer;
      
      try {
        await containerToLog.inspect();
      } catch (inspectError) {
        console.error(`[DockerLogs] Error inspecting container ${containerId}:`, inspectError);
        socket.emit('error', `Failed to access container ${containerId}. It may not exist.`);
        socket.disconnect();
        return;
      }

      console.log(`[DockerLogs] Streaming logs for container ${containerId} on ${currentCredentials.host}`);

      logStream = await containerToLog.logs({
        follow: true,    
        stdout: true,    
        stderr: true,    
        timestamps: true, 
        tail: 100,       
      });

      if (!logStream) { // Should not happen if logs() promise resolves
        throw new Error('Log stream could not be established.');
      }

      logStream.on('data', (chunk: Buffer) => {
        socket.emit('log', chunk.toString('utf8'));
      });

      logStream.on('end', () => {
        console.log(`[DockerLogs] Log stream ended for container ${containerId}`);
        socket.emit('info', 'Log stream ended.');
        socket.disconnect(true);
      });

      logStream.on('error', (err: Error) => {
        console.error(`[DockerLogs] Log stream error for ${containerId}:`, err);
        socket.emit('error', `Error streaming logs: ${err.message}`);
        socket.disconnect(true);
      });

      socket.on('disconnect', (reason: string) => {
        console.log(`[DockerLogs] Socket ${socket.id} disconnected: ${reason}`);
        if (logStream && typeof (logStream as any).destroy === 'function') {
          (logStream as any).destroy(); 
        }
        if (currentCredentials) {
          try {
            manager.releaseUsage(currentCredentials);
          } catch (e) {
            console.error(`[DockerLogs] Error releasing usage on disconnect:`, e);
          }
        }
      });

    } catch (error: any) {
      console.error(`[DockerLogs] Error setting up log stream for ${containerId}:`, error);
      socket.emit('error', `Failed to set up log stream: ${error.message}`);
      socket.disconnect();
      if (currentCredentials) {
         try {
            manager.releaseUsage(currentCredentials);
          } catch (e) {
            console.error(`[DockerLogs] Error releasing usage on setup error:`, e);
          }
      }
    }
  });
} 