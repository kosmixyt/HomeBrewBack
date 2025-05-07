import { SshCredential } from "@prisma/client";
import { Client } from "ssh2";

interface ManagedConnection {
    client: Client;
    usageCount: number; // Renamed from shellCount
    connectionPromise: Promise<Client>;
    status: 'connecting' | 'ready' | 'closed' | 'error';
}

export class SshConnectionManager {
    private static instance: SshConnectionManager;
    private connections: Map<string, ManagedConnection>;

    private constructor() {
        this.connections = new Map();
    }

    public static getInstance(): SshConnectionManager {
        if (!SshConnectionManager.instance) {
            SshConnectionManager.instance = new SshConnectionManager();
        }
        return SshConnectionManager.instance;
    }
    public static clearConnection(credentials: SshCredential): void {
        const instance = SshConnectionManager.getInstance();
        const key = instance.getConnectionKey(credentials);
        const managedConn = instance.connections.get(key);
        if (managedConn) {
            managedConn.client.end(); // Close the client connection
            instance.connections.delete(key); // Remove from the map
            console.log(`[Manager] Cleared connection for ${key}`);
        } else {
            console.warn(`[Manager] No active connection found for ${key} to clear.`);
        }
    }

    private getConnectionKey(credentials: Pick<SshCredential, 'username' | 'host' | 'port'>): string {
        return `${credentials.username}@${credentials.host}:${credentials.port}`;
    }

    public async getSshClient(credentials: SshCredential): Promise<Client> {
        const key = this.getConnectionKey(credentials);
        let managedConn = this.connections.get(key);

        if (managedConn && managedConn.status === 'ready') {
            managedConn.usageCount++; // Updated
            console.log(`[Manager] Reusing SSH client for ${key}. Usages: ${managedConn.usageCount}`); // Updated
            return managedConn.client;
        }

        if (managedConn && managedConn.status === 'connecting') {
            console.log(`[Manager] Waiting for existing connection to ${key}`);
            try {
                const client = await managedConn.connectionPromise;
                const currentMc = this.connections.get(key); // Re-fetch after await
                if (currentMc && currentMc.status === 'ready' && currentMc.client === client) {
                    currentMc.usageCount++; // Updated
                    console.log(`[Manager] Awaited connection for ${key} ready. Usages: ${currentMc.usageCount}`); // Updated
                    return client;
                } else {
                    console.warn(`[Manager] Awaited connection for ${key} no longer valid/ready. Status: ${currentMc?.status}.`);
                    throw new Error(`Awaited connection for ${key} became invalid.`);
                }
            } catch (error) {
                console.error(`[Manager] Awaited connection promise for ${key} failed:`, error);
                // The original promise's error handler should have cleaned up.
                throw error;
            }
        }

        console.log(`[Manager] Creating new SSH client for ${key}`);
        const newClient = new Client();
        const connectionPromise = new Promise<Client>((resolve, reject) => {
            newClient.on('ready', () => {
                console.log(`[Manager] SSH Client for ${key} ready.`);
                const mc = this.connections.get(key); // Should exist
                if (mc) {
                    mc.status = 'ready';
                    mc.usageCount = 1; // First usage for this new connection // Updated
                }
                resolve(newClient);
            });

            newClient.on('error', (err) => {
                console.error(`[Manager] SSH Client for ${key} error:`, err);
                const mc = this.connections.get(key);
                if (mc) mc.status = 'error';
                this.connections.delete(key);
                reject(err);
            });

            newClient.on('close', () => {
                console.log(`[Manager] SSH Client for ${key} closed.`);
                const mc = this.connections.get(key);
                if (mc) mc.status = 'closed';
                this.connections.delete(key);
            });

            newClient.on('end', () => {
                console.log(`[Manager] SSH Client for ${key} ended.`);
                const mc = this.connections.get(key);
                if (mc) mc.status = 'closed'; // Treat end as closed
                this.connections.delete(key);
            });

            newClient.connect({
                host: credentials.host,
                port: credentials.port,
                username: credentials.username,
                password: credentials.password,
            });
        });

        managedConn = {
            client: newClient,
            usageCount: 0, // Will be 1 once 'ready' // Updated
            connectionPromise,
            status: 'connecting',
        };
        this.connections.set(key, managedConn);

        try {
            await connectionPromise;
            return newClient;
        } catch (error) {
            console.error(`[Manager] New connection for ${key} failed:`, error);
            // Error handler in promise should have removed it from map.
            throw error;
        }
    }

    public releaseUsage(credentials: SshCredential): void { // Renamed from releaseShell
        const key = this.getConnectionKey(credentials);
        const managedConn = this.connections.get(key);

        if (managedConn && managedConn.status === 'ready') {
            managedConn.usageCount--; // Updated
            console.log(`[Manager] Usage released for ${key}. Usages remaining: ${managedConn.usageCount}`); // Updated
            if (managedConn.usageCount <= 0) {
                console.log(`[Manager] No active usages for ${key}. Ending client.`); // Updated
                managedConn.client.end(); // This will trigger 'end' and 'close' event handlers
                // No need to delete here, 'close'/'end' handlers will do it.
            }
        } else if (managedConn) {
            console.warn(`[Manager] releaseUsage called for ${key} but status is ${managedConn.status}. Usage count: ${managedConn.usageCount}`); // Updated
            // If called during connecting phase and usageCount is 0, might need to cancel connection if possible or handle carefully.
            // For now, this scenario implies an issue in how usages are acquired/released before 'ready'.
        } else {
            console.warn(`[Manager] releaseUsage called for ${key} but no active managed connection found.`); // Updated
        }
    }
}
