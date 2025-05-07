import express, { NextFunction, Request as ExpressRequest } from 'express'; // Modified import
import { PrismaClient, SshCredential } from '@prisma/client';
import dotenv from 'dotenv';
import { router as userRoutes } from './routes/user';
import { ExpressAuth, getSession } from '@auth/express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { authConfig, prisma } from './utils/config.auth';
import tls from 'tls'; // Added import
import { SshClientRequest } from './ws/Sshconnection';
import { getSessionFromRequest } from './utils/session';
import { sshRouter } from './routes/ssh/route'; // Import the sshRouter
import { sftpRouter } from './routes/ssh/sftp'; // Import the sftpRouter
import { router as linksRouter } from './routes/links'; // Import the linksRouter
import { whoisRouter } from './routes/whois'; // Import the whoisRouter

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

io.of("/ssh").on("connection", async (socket) => {
  const session = await getSessionFromRequest(socket.request);
  if (!session) {
    console.log(`SSH Socket ${socket.id} not authenticated`);
    socket.emit('ssh-error', 'Unauthorized access. Please log in.');
    socket.disconnect();
    return;
  }
  console.log(`SSH Socket ${socket.id} authenticated`);
  try {
    var credentials = await prisma.sshCredential.findUnique({
      where: {
        id: socket.handshake.query.id as string,
        AND: {
          User: {
            // @ts-ignore
            id: session.user.id,
          }
        }
      },
      include: {
        User: true,
      }
    });
    if (!credentials) {
      // @ts-ignore
      console.log(`SSH Socket ${socket.id} invalid credentials id=${socket.handshake.query.id} user_id=${session.user!.id}`);
      socket.emit('ssh-error', 'Invalid SSH credentials.');
      socket.disconnect();
      return;
    }
    console.log(`SSH Socket ${socket.id} connected with credentials:`, credentials.id);
  }
  catch (error) {
    console.error(`Error fetching SSH credentials for socket ${socket.id}:`, error);
    socket.emit('ssh-error', 'Error fetching SSH credentials.');
    socket.disconnect();
    return;
  }
  const sshClient = new SshClientRequest(socket, credentials);
  socket.on('ssh-init', (data: { cols: number, rows: number }) => {
    console.log(`Received ssh-init`);
    if (data && typeof data.cols === 'number' && typeof data.rows === 'number') {
      sshClient.startShell(data.cols, data.rows);
    } else {
      socket.emit('ssh-error', 'Invalid initial dimensions received.');
      socket.disconnect();
    }
  });
  console.log(`SSH client ${socket.id} connected, 'ssh-init' listener attached.`); // Modified log
  socket.on('disconnect', (reason) => {
    console.log(`SSH client ${socket.id} disconnected: ${reason}`);
  });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static('uploads')); // Serve static files from the public directory
app.use('/users', userRoutes);
app.use("/auth/*", ExpressAuth(authConfig));
app.use('/api/ssh-credentials', sshRouter); // Add this line to mount the SSH credentials API
app.use('/api/sftp', sftpRouter); // Add this line to mount the SFTP API
app.use('/api/links', linksRouter); // Add this line to mount the Links API
app.use('/api/whois', whoisRouter); // Ajouter cette ligne pour monter la nouvelle API WHOIS

app.get('/', (req, res) => res.send('Express + TypeScript + Prisma + Auth.js Server is running!'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
