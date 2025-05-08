import { SshCredential } from "@prisma/client";
import { Socket } from "socket.io";
import { Client, ClientChannel } from "ssh2";
import { SshConnectionManager } from "./SshConnectionManager"; // Added import

export class SshClientRequest {
    private socket: Socket;
    private credentials: SshCredential;
    private stream: ClientChannel | null = null;
    private sshClientInstance: Client | null = null; // Stores the ssh2.Client instance for this shell
    private manager: SshConnectionManager;
    private reconnectAttempts = 0;
    private isReconnecting = false;

    constructor(socket: Socket, credentials: SshCredential) {
        this.socket = socket;
        this.credentials = credentials;
        this.manager = SshConnectionManager.getInstance();

        this.socket.on('ssh-resize', (data: { cols: number, rows: number }) => {
            if (this.stream && this.stream.readable && this.stream.writable) {
                this.stream.setWindow(data.rows, data.cols, 0, 0);
            }
        });

        this.socket.on('disconnect', () => {
            console.log(`Socket ${this.socket.id} disconnected, releasing usage for ${this.credentials.username}@${this.credentials.host}`); // Updated
            if (this.sshClientInstance) { // Ensure client was obtained before trying to release
                this.manager.releaseUsage(this.credentials); // Updated
            }
            if (this.stream) {
                this.stream.destroy(); // Forcefully close the stream
                this.stream = null;
            }
            this.sshClientInstance = null; // Clear local reference
        });
    }

    async startShell(initialCols: number, initialRows: number) {
        if (this.isReconnecting) return;
        this.isReconnecting = true;
        try {
            this.sshClientInstance = await this.manager.getSshClient(this.credentials);
            this.reconnectAttempts = 0; // Remet à zéro après succès

            console.log(`SSH Connection for ${this.credentials.username}@${this.credentials.host} obtained. Opening PTY...`);

            // Ajouter un délai initial pour la stabilisation de la connexion
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Nouveau timeout pour l'ouverture du shell
            const shellTimeout = 1000; // 10 secondes
            let timeoutHandle: NodeJS.Timeout;

            const stream = await new Promise<ClientChannel>((resolve, reject) => {
                console.log("sshClientInstance");
                timeoutHandle = setTimeout(() => {
                    console.log(`Échec de l'ouverture du shell après ${shellTimeout}ms`);
                    reject(new Error(`Échec de l'ouverture du shell après ${shellTimeout}ms`));
                }, shellTimeout);

                if(!this.sshClientInstance){
                    reject(new Error('SSH client not found'));
                    return;
                }
                this.sshClientInstance.shell(
                    { rows: initialRows, cols: initialCols, term: 'xterm-256color' },
                    (err, stream) => {
                        console.log(`Stream obtenu pour socket ${this.socket.id}`);
                        clearTimeout(timeoutHandle);
                        if (err) {
                            reject(err);
                        } else if (!stream) {
                            reject(new Error('Le flux shell est indéfini'));
                        } else {
                            resolve(stream);
                        }
                    }
                );
            });

            this.stream = stream;
            console.log(`PTY ready for socket ${this.socket.id}. Terminal active.`);
            this.socket.emit("ssh-ready", "PTY ready. Terminal active.");

            this.socket.on("ssh-data", (data: string) => {
                if (this.stream && this.stream.writable && !this.stream.writableEnded) {
                    this.stream.write(data);
                }
            });

            stream.on("data", (data: Buffer) => {
                this.socket.emit("ssh-data", data.toString());
            });

            stream.on("close", () => {
                console.log(`Stream closed for socket ${this.socket.id}`);
                this.socket.emit("ssh-error", "SSH Stream Closed");
                if (this.sshClientInstance) {
                    this.manager.releaseUsage(this.credentials); // Updated
                }
                this.stream = null;
                // Do not end sshClientInstance here; manager handles its lifecycle.
            });

            stream.on("error", (streamErr: Error) => {
                console.log(`Stream error for socket ${this.socket.id}:`, streamErr);
                this.socket.emit("ssh-error", `Stream error: ${streamErr.message}`);
                if (this.sshClientInstance) {
                    this.manager.releaseUsage(this.credentials); // Updated
                }
                this.stream = null;
            });

        } catch (error: any) {
            console.error(`Échec de l'ouverture du shell:`, error);
            if (this.socket.connected) {
                this.socket.emit("ssh-error", `Erreur de connexion: ${error.message}`);
            }
            this.manager.releaseUsage(this.credentials);
            this.sshClientInstance = null;
            if (this.reconnectAttempts < 3) {
                this.reconnectAttempts++;
                setTimeout(() => {
                    this.startShell(initialCols, initialRows);
                }, 1000 * this.reconnectAttempts);
            }
        } finally {
            this.isReconnecting = false;
        }
    }

    // The original onready, onerror, onclose, onend for the SshConnection (Client)
    // are now managed by SshConnectionManager. SshClientRequest focuses on the shell stream.
}