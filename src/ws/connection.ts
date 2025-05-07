import { SshCredential } from "@prisma/client";
import { Socket } from "socket.io";

import { Client, ClientChannel } from "ssh2";

export class SshClientRequest {
    private socket : Socket;
    private SshConnection :  Client;
    private credentials : SshCredential;
    private stream: ClientChannel | null = null;

    constructor(socket: Socket, credentials: SshCredential) {
        this.socket = socket;
        this.credentials = credentials;
        this.SshConnection = new Client();

        this.socket.on('ssh-resize', (data: { cols: number, rows: number }) => {
            if (this.stream) {
                this.stream.setWindow(data.rows, data.cols, 0, 0);
            }
        });
    }

    startShell(initialCols: number, initialRows: number){
        const props = {
            host: this.credentials.host,
            port: this.credentials.port,
            username: this.credentials.username,
            password: this.credentials.password,
        };

        this.SshConnection.on("ready", () => this.onready(initialCols, initialRows));
        this.SshConnection.on("error", (err) => this.onerror(err));
        this.SshConnection.on("close", () => {
            this.socket.emit("ssh-error", "SSH Connection Closed");
            console.log("SSH Connection Closed");
            this.stream = null;
        });
        this.SshConnection.on("end", () => {
            this.socket.emit("ssh-error", "SSH Connection Ended");
            console.log("SSH Connection Ended");
            this.stream = null;
        });

        this.SshConnection.connect(props);
    }

    onready(initialCols: number, initialRows: number){
        console.log("SSH Connection Ready");
        this.socket.emit("ssh-ready", "SSH connection established. Opening PTY...");
        this.SshConnection.shell({ rows: initialRows, cols: initialCols, term: 'xterm-256color' }, (err, stream) => {
            if (err) {
                console.log("Shell error:", err);
                this.socket.emit("ssh-error", `Shell error: ${err.message}`);
                return;
            }
            this.stream = stream;

            this.socket.emit("ssh-ready", "PTY ready. Terminal active.");

            this.socket.on("ssh-data", (data: string) => {
                if (this.stream && !this.stream.writableEnded) {
                    this.stream.write(data);
                }
            });
            stream.on("data", (data: Buffer) => {
                this.socket.emit("ssh-data", data.toString());
            });
            stream.on("close", () => {
                console.log("Stream closed");
                this.socket.emit("ssh-error", "SSH Stream Closed");
                this.SshConnection.end();
                this.stream = null;
            });
            stream.on("error", (streamErr : Error) => {
                console.log("Stream error:", streamErr);
                this.socket.emit("ssh-error", `Stream error: ${streamErr.message}`);
                this.stream = null;
            });
        });
    }

    onerror(err: Error){
        console.error("SSH Connection Error:", err);
        this.socket.emit("ssh-error", `SSH Connection Error: ${err.message}`);
        this.stream = null;
    }
}