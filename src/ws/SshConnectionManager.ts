import { SshCredential } from "@prisma/client";
import { Client } from "ssh2";
import childProcess from "child_process";
import Dockerode from "dockerode";
import net from "net";
import { CheckSetupDocker, DockerCertificates, GetCertificates } from "../utils/dockerSetup";
import fs from "fs";
import { ConfigureRemoteDocker } from "../utils/dockerSetup";

interface ManagedConnection {
  client: Client;
  usageCount: number;
  connectionPromise: Promise<Client>;
  status: "connecting" | "ready" | "closed" | "error";
  dockerode?: Dockerode;
  dockerodePromise?: Promise<Dockerode>; // Promise for ongoing Dockerode setup
}

interface DockerConnection {
  dockerode: Dockerode;
  sshProcess?: childProcess.ChildProcess;
  port: number;
}

export class SshConnectionManager {
  private static instance: SshConnectionManager;
  private connections: Map<string, ManagedConnection>;
  private dockerConnections: Map<string, DockerConnection>; // Stockage persistant des connexions Docker

  private constructor() {
    this.connections = new Map();
    this.dockerConnections = new Map();
  }

  public static getInstance(): SshConnectionManager {
    if (!SshConnectionManager.instance) {
      SshConnectionManager.instance = new SshConnectionManager();
    }
    return SshConnectionManager.instance;
  }

  private getConnectionKey(
    credentials: Pick<SshCredential, "username" | "host" | "port">
  ): string {
    return `${credentials.username}@${credentials.host}:${credentials.port}`;
  }

  public async getSshClient(credentials: SshCredential): Promise<Client> {
    const key = this.getConnectionKey(credentials);
    let managedConn = this.connections.get(key);

    if (managedConn && managedConn.status === "ready") {
      managedConn.usageCount++;
      console.log(
        `[Manager] Réutilisation connexion ${key}. Utilisations: ${managedConn.usageCount}`
      );
      return managedConn.client;
    }

    if (managedConn && managedConn.status === "closed") {
      this.connections.delete(key);
      managedConn = undefined;
    }

    if (managedConn && managedConn.status === "connecting") {
      console.log(`[Manager] Waiting for existing connection to ${key}`);
      try {
        const client = await managedConn.connectionPromise;
        const currentMc = this.connections.get(key);
        if (
          currentMc &&
          currentMc.status === "ready" &&
          currentMc.client === client
        ) {
          currentMc.usageCount++;
          console.log(
            `[Manager] Awaited connection for ${key} ready. Usages: ${currentMc.usageCount}`
          );
          return client;
        } else {
          console.warn(
            `[Manager] Awaited connection for ${key} no longer valid/ready. Status: ${currentMc?.status}.`
          );
          throw new Error(`Awaited connection for ${key} became invalid.`);
        }
      } catch (error) {
        console.error(
          `[Manager] Awaited connection promise for ${key} failed:`,
          error
        );
        throw error;
      }
    }

    console.log(`[Manager] Creating new SSH client for ${key}`);
    const newClient = new Client();
    const connectionPromise = new Promise<Client>((resolve, reject) => {
      newClient.on("ready", () => {
        console.log(`[Manager] SSH Client for ${key} ready.`);
        const mc = this.connections.get(key);
        if (mc) {
          mc.status = "ready";
          mc.usageCount = 1;
        }
        resolve(newClient);
      });

      newClient.on("error", (err) => {
        console.error(`[Manager] SSH Client for ${key} error:`, err);
        const mc = this.connections.get(key);
        if (mc) {
          mc.status = "error";
          mc.dockerode = undefined;
          mc.dockerodePromise = undefined;
        }
        this.connections.delete(key);
        reject(err);
      });

      newClient.on("close", () => {
        console.log(`[Manager] SSH Client for ${key} closed.`);
        const mc = this.connections.get(key);
        if (mc) {
          mc.status = "closed";
          mc.dockerode = undefined;
          mc.dockerodePromise = undefined;
        }
        this.connections.delete(key);
      });

      newClient.on("end", () => {
        console.log(`[Manager] SSH Client for ${key} ended.`);
        const mc = this.connections.get(key);
        if (mc) {
          mc.status = "closed";
          mc.dockerode = undefined;
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
      status: "connecting",
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
    // Vérifier si on a déjà une connexion Docker pour cet hôte
    const key = this.getConnectionKey(credentials);
    const existingDocker = this.dockerConnections.get(key);
    
    if (existingDocker) {
      console.log(`[Manager] Reusing persistent Dockerode instance for ${key}`);
      return existingDocker.dockerode;
    }

    // Sinon, créer une nouvelle connexion SSH et Docker
    await this.getSshClient(credentials);
    const managedConn = this.connections.get(key);

    if (!managedConn || managedConn.status !== "ready") {
      console.error(
        `[Manager] Inconsistency after getSshClient for ${key}. Status: ${managedConn?.status}.`
      );
      throw new Error(
        `Failed to establish a consistent SSH client state for Dockerode for ${key}`
      );
    }

    if (managedConn.dockerodePromise) {
      console.log(`[Manager] Waiting for existing Dockerode setup for ${key}.`);
      return managedConn.dockerodePromise;
    }

    const dockerodeSetupPromise = new Promise<Dockerode>(async (resolveDockerode, rejectDockerode) => {
      try {
        const randomPort = Math.floor(Math.random() * 10000) + 2375;
        console.log(`[Manager] Starting SSH port forwarding for Docker on ${key} (port ${randomPort})`);
        
        const proc = childProcess.spawn('ssh', [
          "-NL", `${randomPort}:/var/run/docker.sock`,
          "-i", "C:/Users/flocl/Desktop/keys/main",
          `${credentials.username}@${credentials.host}`, "-p", `${credentials.port}`
        ], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        
        proc.on('error', (err) => {
          console.error(`[Manager] SSH forwarding error for ${key}:`, err);
          rejectDockerode(new Error(`SSH port forwarding failed: ${err.message}`));
        });

        // Attendre que le tunnel soit établi
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const docker = new Dockerode({
          protocol: 'http',
          host: 'localhost',
          port: randomPort,
        });
        
        // Stocker la connexion Docker de manière persistante
        this.dockerConnections.set(key, {
          dockerode: docker,
          sshProcess: proc,
          port: randomPort
        });
        
        console.log(`[Manager] Docker connection established for ${key} on port ${randomPort}`);
        managedConn.dockerode = docker;
        resolveDockerode(docker);
      } catch (error) {
        console.error(`[Manager] Docker setup failed for ${key}:`, error);
        managedConn.dockerodePromise = undefined;
        rejectDockerode(error);
      }
    });
    
    managedConn.dockerodePromise = dockerodeSetupPromise;
    return dockerodeSetupPromise;
  }

  public releaseUsage(credentials: SshCredential): void {
    const key = this.getConnectionKey(credentials);
    const managedConn = this.connections.get(key);
    if (managedConn && managedConn.status === "ready") {
      managedConn.usageCount = Math.max(0, managedConn.usageCount - 1);
      console.log(
        `[Manager] Usage libéré pour ${key}. Restant: ${managedConn.usageCount}`
      );
      
      if (managedConn.usageCount === 0) {
        console.log(`[Manager] Fermeture connexion SSH inutilisée ${key}`);
        managedConn.client.end();
        this.connections.delete(key);
        // Ne pas supprimer la connexion Docker, elle reste persistante
      }
    } else if (managedConn) {
      console.warn(
        `[Manager] releaseUsage called for ${key} but status is ${managedConn.status}. Usage count: ${managedConn.usageCount}`
      );
    } else {
      console.warn(
        `[Manager] releaseUsage called for ${key} but no active managed connection found.`
      );
    }
  }
}
