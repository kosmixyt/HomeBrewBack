import { SshCredential } from "@prisma/client";
import { Client } from "ssh2";
import Dockerode from 'dockerode';
import net from "net"


interface ManagedConnection {
    client: Client;
    usageCount: number;
    connectionPromise: Promise<Client>;
    status: 'connecting' | 'ready' | 'closed' | 'error';
    dockerode?: Dockerode;
    localForwardPort?: number; // Port on localhost forwarding to remote Docker
    dockerodePromise?: Promise<Dockerode>; // Promise for ongoing Dockerode setup
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


    private getConnectionKey(credentials: Pick<SshCredential, 'username' | 'host' | 'port'>): string {
        return `${credentials.username}@${credentials.host}:${credentials.port}`;
    }

    public async getSshClient(credentials: SshCredential): Promise<Client> {
        const key = this.getConnectionKey(credentials);
        let managedConn = this.connections.get(key);

        if (managedConn && managedConn.status === 'ready') {
            managedConn.usageCount++;
            console.log(`[Manager] Reusing SSH client for ${key}. Usages: ${managedConn.usageCount}`);
            return managedConn.client;
        }

        if (managedConn && managedConn.status === 'connecting') {
            console.log(`[Manager] Waiting for existing connection to ${key}`);
            try {
                const client = await managedConn.connectionPromise;
                const currentMc = this.connections.get(key);
                if (currentMc && currentMc.status === 'ready' && currentMc.client === client) {
                    currentMc.usageCount++;
                    console.log(`[Manager] Awaited connection for ${key} ready. Usages: ${currentMc.usageCount}`);
                    return client;
                } else {
                    console.warn(`[Manager] Awaited connection for ${key} no longer valid/ready. Status: ${currentMc?.status}.`);
                    throw new Error(`Awaited connection for ${key} became invalid.`);
                }
            } catch (error) {
                console.error(`[Manager] Awaited connection promise for ${key} failed:`, error);
                throw error;
            }
        }

        console.log(`[Manager] Creating new SSH client for ${key}`);
        const newClient = new Client();
        const connectionPromise = new Promise<Client>((resolve, reject) => {
            newClient.on('ready', () => {
                console.log(`[Manager] SSH Client for ${key} ready.`);
                const mc = this.connections.get(key);
                if (mc) {
                    mc.status = 'ready';
                    mc.usageCount = 1;
                }
                resolve(newClient);
            });

            newClient.on('error', (err) => {
                console.error(`[Manager] SSH Client for ${key} error:`, err);
                const mc = this.connections.get(key);
                if (mc) {
                    mc.status = 'error';
                    mc.dockerode = undefined;
                    mc.localForwardPort = undefined;
                    mc.dockerodePromise = undefined;
                }
                this.connections.delete(key);
                reject(err);
            });

            newClient.on('close', () => {
                console.log(`[Manager] SSH Client for ${key} closed.`);
                const mc = this.connections.get(key);
                if (mc) {
                    mc.status = 'closed';
                    mc.dockerode = undefined;
                    mc.localForwardPort = undefined;
                    mc.dockerodePromise = undefined;
                }
                this.connections.delete(key);
            });

            newClient.on('end', () => {
                console.log(`[Manager] SSH Client for ${key} ended.`);
                const mc = this.connections.get(key);
                if (mc) {
                    mc.status = 'closed';
                    mc.dockerode = undefined;
                    mc.localForwardPort = undefined;
                    mc.dockerodePromise = undefined;
                }
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
            usageCount: 0,
            connectionPromise,
            status: 'connecting',
        };
        this.connections.set(key, managedConn);

        try {
            await connectionPromise;
            return newClient;
        } catch (error) {
            console.error(`[Manager] New connection for ${key} failed:`, error);
            throw error;
        }
    }

    public async getDockerode(credentials: SshCredential): Promise<Dockerode> {
        const sshClient = await this.getSshClient(credentials);
        const key = this.getConnectionKey(credentials);
        const managedConn = this.connections.get(key);

        if (!managedConn || managedConn.client !== sshClient || managedConn.status !== 'ready') {
            console.error(`[Manager] Inconsistency after getSshClient for ${key}. Status: ${managedConn?.status}. Re-throwing error.`);
            throw new Error(`Failed to establish a consistent SSH client state for Dockerode for ${key}`);
        }

        if (managedConn.dockerode) {
            console.log(`[Manager] Reusing Dockerode instance for ${key} on local port ${managedConn.localForwardPort}.`);
            return managedConn.dockerode;
        }

        if (managedConn.dockerodePromise) {
            console.log(`[Manager] Waiting for existing Dockerode setup for ${key}.`);
            return managedConn.dockerodePromise;
        }

        console.log(`[Manager] Creating new Dockerode instance for ${key}. Setting up SSH port forwarding.`);
        const dockerodeSetupPromise = new Promise<Dockerode>((resolveDockerode, rejectDockerode) => {
            // Configure Dockerode with longer timeout
            const docker = new Dockerode({
                protocol: 'http',
                host: `http://${credentials.host}:2376`,
                ca: "",
                cert: "",
                key: "",
            });
            docker.ping()
                .then(() => {
                    console.log(`[Manager] Docker ping successful for ${key}. Connection verified.`);
                    managedConn.dockerode = docker;
                    resolveDockerode(docker);
                })
                .catch(pingErr => {
                    console.error(`[Manager] Docker ping failed for ${key}:`, pingErr);
                    rejectDockerode(new Error(`Docker connection test failed: ${pingErr.message}`));
                });
            return managedConn.dockerodePromise;
        });
        managedConn.dockerodePromise = dockerodeSetupPromise;
        return dockerodeSetupPromise;

    }

    public releaseUsage(credentials: SshCredential): void {
        const key = this.getConnectionKey(credentials);
        const managedConn = this.connections.get(key);

        if (managedConn && managedConn.status === 'ready') {
            managedConn.usageCount--;
            console.log(`[Manager] Usage released for ${key}. Usages remaining: ${managedConn.usageCount}`);
            if (managedConn.usageCount <= 0) {
                console.log(`[Manager] No active usages for ${key}. Ending client.`);
                managedConn.client.end();
            }
        } else if (managedConn) {
            console.warn(`[Manager] releaseUsage called for ${key} but status is ${managedConn.status}. Usage count: ${managedConn.usageCount}`);
        } else {
            console.warn(`[Manager] releaseUsage called for ${key} but no active managed connection found.`);
        }
    }
}
