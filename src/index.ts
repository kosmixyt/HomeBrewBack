import express, { NextFunction, Request as ExpressRequest } from 'express'; // Modified import
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { router as userRoutes } from './routes/user';
import { ExpressAuth, getSession } from '@auth/express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { authConfig, prisma } from './utils/config.auth';
import tls from 'tls'; // Added import
import { SshClientRequest } from './ws/connection';

dotenv.config();

var app = express();
const server = http.createServer(app);

export const io = new SocketIOServer(server, {
  cors: {
    credentials: true,
    origin: "http://localhost:5173", // Configure this for your frontend's origin in production
    methods: ["GET", "POST"],
  },
});
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "http://localhost:5173"); // Update this to your frontend's origin in production
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Credentials", "true");
  next();
})

io.on('connection', async (socket) => {
  const { headers } = socket.request;
  const host = headers.host;
  let protocol = 'http';
  if ((socket.request.connection as tls.TLSSocket).encrypted) {
    protocol = 'https';
  }
  const forwardedProtoHeader = headers['x-forwarded-proto'];
  if (typeof forwardedProtoHeader === 'string') {
    protocol = forwardedProtoHeader.split(',')[0].trim();
  }

  const mockExpressRequest = {
    headers: headers, // Provides req.headers.cookie for getSession
    protocol: protocol, // Provides req.protocol for getSession
    get: (name: string): string | undefined => { // Provides req.get(name) for getSession
      if (name.toLowerCase() === 'host') {
        return host;
      }
      // Express's req.get() also normalizes other header names to lowercase.
      // This simplified version covers 'host' and direct lowercase access.
      return headers[name.toLowerCase()] as string | undefined;
    },
    // Add other Express.Request properties if getSession implementation were to need them.
    // Based on @auth/express source, `req.protocol`, `req.get("host")`,
    // and `req.headers.cookie` are the primary needs.
  } as ExpressRequest; // Type assertion to satisfy getSession's parameter type

  const session = await getSession(mockExpressRequest, authConfig);
  console.log('A user connected via Socket.IO:', socket.id, session);
  if(!session) {
    console.log("Session not found, disconnecting socket");
    socket.disconnect();
    return;
  }
});
io.of("/ssh").on("connection", (socket) => {
  
  // Do not connect immediately. Wait for client to send initial dimensions.
  const sshClient = new SshClientRequest(socket, {
} as any);

  socket.on('ssh-init', (data: { cols: number, rows: number }) => {
    console.log(`Received ssh-init from ${socket.id} with dimensions:`, data);
    if (data && typeof data.cols === 'number' && typeof data.rows === 'number') {
      sshClient.startShell(data.cols, data.rows);
    } else {
      socket.emit('ssh-error', 'Invalid initial dimensions received.');
      socket.disconnect();
    }
  });
  console.log(`SSH client ${socket.id} connected`);

  socket.on('disconnect', (reason) => {
    console.log(`SSH client ${socket.id} disconnected: ${reason}`);
    // sshClient.SshConnection.end(); // SshClientRequest should handle its own cleanup on socket events or errors
  });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/users', userRoutes);
app.use("/auth/*",  ExpressAuth(authConfig))
app.get('/', (req, res) => res.send('Express + TypeScript + Prisma + Auth.js Server is running!'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
