import express from 'express';
import { getSession } from '@auth/express';
import { Client, SFTPWrapper } from 'ssh2';
import { SshConnectionManager } from '../../ws/SshConnectionManager';
import { authConfig, prisma } from '../../utils/config.auth'; // Adjusted path
import multer from 'multer';
import pathModule from 'path'; // Using pathModule to avoid conflict with 'path' variable

// Configure multer for memory storage (or disk storage if preferred for larger files)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

export const sftpRouter = express.Router();

sftpRouter.get('/:credentialId/list', async (req, res) => {
    // @ts-ignore
    const session = await getSession(req, authConfig);
    // @ts-ignore
    if (!session || !session.user || !session.user.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { credentialId } = req.params;
    const path = typeof req.query.path === 'string' ? req.query.path : '.';

    try {
        const credential = await prisma.sshCredential.findUnique({
            where: {
                id: credentialId,
                // @ts-ignore
                userId: session.user.id
            }
        });

        if (!credential) {
            return res.status(404).json({ error: 'Credential not found or access denied' });
        }

        const manager = SshConnectionManager.getInstance();
        let sshClient: Client | null = null;
        let sftp: SFTPWrapper | null = null;

        try {
            sshClient = await manager.getSshClient(credential);

            sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
                sshClient!.sftp((err, sftpInstance) => {
                    if (err) return reject(err);
                    resolve(sftpInstance);
                });
            });

            const entries: SFTPWrapper.Dirent[] = await new Promise((resolve, reject) => {
                sftp!.readdir(path, (err, list) => {
                    if (err) return reject(err);
                    resolve(list);
                });
            });

            const fileDetails = entries.map(entry => ({
                name: entry.filename,
                isDirectory: entry.attrs.isDirectory(),
                isFile: entry.attrs.isFile(),
                isSymLink: entry.attrs.isSymbolicLink(),
                size: entry.attrs.size,
                permissionsOctal: entry.attrs.mode.toString(8),
                modifiedDate: new Date(entry.attrs.mtime * 1000).toISOString(),
                longname: entry.longname, // For additional info or debugging
            })).sort((a, b) => { // Sort: directories first, then by name
                if (a.isDirectory && !b.isDirectory) return -1;
                if (!a.isDirectory && b.isDirectory) return 1;
                return a.name.localeCompare(b.name);
            });

            sftp.end();
            sftp = null; // Mark as closed
            res.json(fileDetails);

        } catch (error: any) {
            console.error(`SFTP operation failed for credential ${credentialId}, path "${path}":`, error);
            if (sftp) {
                sftp.end(); // Ensure SFTP session is closed on error
            }
            res.status(500).json({ error: 'SFTP operation failed', details: error.message });
        } finally {
            if (sshClient) {
                manager.releaseUsage(credential);
            }
        }
    } catch (error: any) {
        console.error('Error fetching credential or session for SFTP:', error);
        res.status(500).json({ error: 'Server error during SFTP request preparation' });
    }
});

sftpRouter.get('/:credentialId/download', async (req, res) => {
    // @ts-ignore
    const session = await getSession(req, authConfig);
    // @ts-ignore
    if (!session || !session.user || !session.user.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { credentialId } = req.params;
    const filePath = typeof req.query.path === 'string' ? req.query.path : null;

    if (!filePath) {
        return res.status(400).json({ error: 'File path is required' });
    }

    try {
        const credential = await prisma.sshCredential.findUnique({
            where: {
                id: credentialId,
                // @ts-ignore
                userId: session.user.id
            }
        });

        if (!credential) {
            return res.status(404).json({ error: 'Credential not found or access denied' });
        }

        const manager = SshConnectionManager.getInstance();
        let sshClient: Client | null = null;
        let sftp: SFTPWrapper | null = null;

        try {
            sshClient = await manager.getSshClient(credential);
            sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
                sshClient!.sftp((err, sftpInstance) => {
                    if (err) return reject(err);
                    resolve(sftpInstance);
                });
            });

            const fileName = pathModule.basename(filePath);
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            res.setHeader('Content-Type', 'application/octet-stream');

            const readStream = sftp.createReadStream(filePath);

            readStream.on('error', (err) => {
                console.error(`SFTP ReadStream error for ${filePath}:`, err);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Failed to read file from SFTP server', details: err.message });
                } else {
                    res.end();
                }
                sftp?.end();
            });

            readStream.on('close', () => {
                sftp?.end();
            });

            readStream.pipe(res);

        } catch (error: any) {
            console.error(`SFTP download operation failed for credential ${credentialId}, path "${filePath}":`, error);
            if (sftp && !sftp.readableEnded) {
                sftp.end();
            }
            if (!res.headersSent) {
                res.status(500).json({ error: 'SFTP download failed', details: error.message });
            }
        } finally {
            if (sshClient) {
                res.on('finish', () => {
                    if (sshClient && credential) manager.releaseUsage(credential);
                });
                res.on('error', () => {
                    if (sshClient && credential) manager.releaseUsage(credential);
                });
            }
        }
    } catch (error: any) {
        console.error('Error fetching credential or session for SFTP download:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Server error during SFTP download preparation' });
        }
    }
});

sftpRouter.post('/:credentialId/upload', upload.single('file'), async (req, res) => {
    // @ts-ignore
    const session = await getSession(req, authConfig);
    // @ts-ignore
    if (!session || !session.user || !session.user.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const { credentialId } = req.params;
    const remotePath = typeof req.body.path === 'string' ? req.body.path : '.';
    const originalFileName = req.file.originalname;
    const remoteFilePath = pathModule.join(remotePath, originalFileName);

    try {
        const credential = await prisma.sshCredential.findUnique({
            where: {
                id: credentialId,
                // @ts-ignore
                userId: session.user.id
            }
        });

        if (!credential) {
            return res.status(404).json({ error: 'Credential not found or access denied' });
        }

        const manager = SshConnectionManager.getInstance();
        let sshClient: Client | null = null;
        let sftp: SFTPWrapper | null = null;

        try {
            sshClient = await manager.getSshClient(credential);
            sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
                sshClient!.sftp((err, sftpInstance) => {
                    if (err) return reject(err);
                    resolve(sftpInstance);
                });
            });

            const writeStream = sftp.createWriteStream(remoteFilePath, {});

            writeStream.on('error', (err) => {
                console.error(`SFTP WriteStream error for ${remoteFilePath}:`, err);
                sftp?.end();
                res.status(500).json({ error: 'Failed to write file to SFTP server', details: err.message });
            });

            writeStream.on('close', () => {
                sftp?.end();
                res.status(200).json({ message: `File ${originalFileName} uploaded successfully to ${remoteFilePath}` });
            });

            writeStream.end(req.file.buffer);

        } catch (error: any) {
            console.error(`SFTP upload operation failed for credential ${credentialId}, path "${remoteFilePath}":`, error);
            if (sftp) sftp.end();
            res.status(500).json({ error: 'SFTP upload failed', details: error.message });
        } finally {
            if (sshClient) {
                manager.releaseUsage(credential);
            }
        }
    } catch (error: any) {
        console.error('Error fetching credential or session for SFTP upload:', error);
        res.status(500).json({ error: 'Server error during SFTP upload preparation' });
    }
});

sftpRouter.post('/:credentialId/validate-path', async (req, res) => {
    // @ts-ignore
    const session = await getSession(req, authConfig);
    // @ts-ignore
    if (!session || !session.user || !session.user.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { credentialId } = req.params;
    const { path: dirPath } = req.body;

    if (typeof dirPath !== 'string' || !dirPath) {
        return res.status(400).json({ error: 'Directory path is required' });
    }

    try {
        const credential = await prisma.sshCredential.findUnique({
            where: {
                id: credentialId,
                // @ts-ignore
                userId: session.user.id
            }
        });

        if (!credential) {
            return res.status(404).json({ error: 'Credential not found or access denied' });
        }

        const manager = SshConnectionManager.getInstance();
        let sshClient: Client | null = null;
        let sftp: SFTPWrapper | null = null;

        try {
            sshClient = await manager.getSshClient(credential);
            sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
                sshClient!.sftp((err, sftpInstance) => {
                    if (err) return reject(err);
                    resolve(sftpInstance);
                });
            });

            await new Promise<SFTPWrapper.Stats>((resolve, reject) => {
                sftp!.stat(dirPath, (err, stats) => {
                    if (err) {
                        return reject(new Error(`Path not found or inaccessible: ${err.message}`));
                    }
                    if (!stats.isDirectory()) {
                        return reject(new Error('Path is not a directory'));
                    }
                    resolve(stats);
                });
            });

            sftp.end();
            sftp = null;
            res.json({ message: 'Path is a valid directory', path: dirPath });

        } catch (error: any) {
            console.error(`SFTP path validation failed for credential ${credentialId}, path "${dirPath}":`, error);
            if (sftp) sftp.end();
            res.status(500).json({ error: 'SFTP path validation failed', details: error.message });
        } finally {
            if (sshClient) {
                manager.releaseUsage(credential);
            }
        }
    } catch (error: any) {
        console.error('Error during SFTP path validation preparation:', error);
        res.status(500).json({ error: 'Server error during SFTP path validation' });
    }
});
