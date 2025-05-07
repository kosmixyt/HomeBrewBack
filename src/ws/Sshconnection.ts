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
        try {
            this.sshClientInstance = await this.manager.getSshClient(this.credentials);

            console.log(`SSH Connection for ${this.credentials.username}@${this.credentials.host} obtained. Opening PTY for socket ${this.socket.id}...`);

            this.sshClientInstance.shell({ rows: initialRows, cols: initialCols, term: 'xterm-256color' }, (err, stream) => {
                this.socket.emit("ssh-ready", "SSH connection established. Opening PTY...");
                if (err) {
                    console.log(`Shell error for socket ${this.socket.id}:`, err);
                    this.socket.emit("ssh-error", `Shell error: ${err.message}`);
                    // If shell fails to open, release the count from manager
                    if (this.sshClientInstance) { // Check as a precaution
                        this.manager.releaseUsage(this.credentials); // Updated
                    }
                    this.sshClientInstance = null;
                    return;
                }
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
            });

        } catch (error: any) {
            console.error(`Failed to start shell for socket ${this.socket.id}:`, error);
            this.socket.emit("ssh-error", `Failed to establish SSH connection: ${error.message || 'Unknown error'}`);
            // If getSshClient failed, sshClientInstance is null.
            // The manager handles cleanup of its own failed connection attempts.
            this.sshClientInstance = null; // Ensure it's null if setup failed
        }
    }

    // The original onready, onerror, onclose, onend for the SshConnection (Client)
    // are now managed by SshConnectionManager. SshClientRequest focuses on the shell stream.
}