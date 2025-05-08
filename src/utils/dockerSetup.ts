import pem from "pem";
import fs from "fs";
import { SshCredential } from "@prisma/client";
import { Client, SFTPWrapper } from "ssh2";
import dns from "dns";

export async function GetCertificates(
  credentials: SshCredential,
  sshClient: Client
): Promise<DockerCertificates> {
  // Résolution DNS si credentials.host est un nom de domaine
  function isIp(host: string) {
    return /^\d+\.\d+\.\d+\.\d+$/.test(host) || /^[a-fA-F0-9:]+$/.test(host);
  }
  const altNames: string[] = [];
  let hostIp = credentials.host;
  if (!isIp(credentials.host)) {
    try {
      // On résout le nom de domaine en IP (IPv4 prioritaire, puis IPv6)
      let addresses: string[] = [];
      try {
        addresses = await new Promise<string[]>((resolve, reject) => {
          dns.resolve4(credentials.host, (err, addresses) => {
            if (err) return resolve([]); // On ne rejette pas, on tente IPv6 après
            resolve(addresses);
          });
        });
      } catch {}
      if (addresses.length === 0) {
        // Si pas d'IPv4, on tente IPv6
        addresses = await new Promise<string[]>((resolve, reject) => {
          dns.resolve6(credentials.host, (err, addresses) => {
            if (err) return resolve([]);
            resolve(addresses);
          });
        });
      }
      if (addresses.length > 0) {
        hostIp = addresses[0];
        for (const addr of addresses) {
          altNames.push(`IP:${addr}`);
        }
      }
      // Toujours ajouter le DNS aussi
      altNames.push(`DNS:${credentials.host}`);
    } catch (e) {
      // Si la résolution échoue, on garde le host d'origine
      altNames.push(`DNS:${credentials.host}`);
    }
  } else {
    altNames.push(`IP:${credentials.host}`);
  }
  return new Promise((resolve, reject) => {
    // Generate a self-signed certificate for the Docker server
    pem.createCertificate({ days: 365, selfSigned: true }, (err, ca) => {
      if (err) {
        return reject(err);
      }
      console.log(err);
      console.log(altNames, "altNames")
      // Create a self-signed certificate for the Docker server
      pem.createCertificate(
        {
          serviceKey: ca.serviceKey,
          serviceCertificate: ca.certificate,
          serial: Date.now(),
          days: 365,
          commonName: credentials.host,
          altNames: altNames,
        },
        (err, serverCert) => {
          if (err) {
            return reject(err);
          }
          pem.createCertificate(
            {
              serviceKey: ca.serviceKey,
              serviceCertificate: ca.certificate,
              serial: Date.now() + 1,
              days: 365,
              commonName: "docker-client",
              clientKeyPassword: "test",
            },
            (err, clientCert) => {
              if (err) {
                return reject(err);
              }
              if (!fs.existsSync(`./certs/${credentials.id}/`))
                fs.mkdirSync(`./certs/${credentials.id}/`, { recursive: true });
              const certs: DockerCertificates = {
                "ca.pem": ca.certificate,
                "server-cert.pem": serverCert.certificate,
                "server-key.pem": serverCert.clientKey,
                "cert.pem": clientCert.certificate,
                "key.pem": clientCert.clientKey,
              };
              for (const key in certs) {
                fs.writeFileSync(
                  `./certs/${credentials.id}/${key}`,
                  certs[key]
                );
              }
              resolve(certs);
            }
          );
        }
      );
    });
  });
}

export async function CheckSetupDocker(sshClient: Client): Promise<boolean> {
  return new Promise((resolve) => {
    sshClient.sftp(async (sftpErr, sftp) => {
      if (sftpErr) return resolve(false);
      sftp.readFile(`/etc/docker/daemon.json`, (err, data) => {
        if (err) return resolve(false);
        try {
          const daemonJson = JSON.parse(data.toString());
          resolve(daemonJson.tlsverify);
        } catch (e) {
          resolve(false);
        }
      });
    });
  });
}

export async function ConfigureRemoteDocker(
  sshClient: Client,
  certs: DockerCertificates
) {
  return new Promise<void>(async (resolve, reject) => {
    sshClient.sftp(async (sftpErr, sftp) => {
      if (sftpErr) return reject(sftpErr);
      await Mkdir(sftp, `/etc/docker/certs`);
      for (const key in certs) {
        await WriteFile(sftp, `/etc/docker/certs/${key}`, certs[key]);
      }
      await WriteFile(
        sftp,
        `/etc/docker/daemon.json`,
        JSON.stringify({
          tlsverify: true,
          tlscacert: "/etc/docker/certs/ca.pem",
          tlscert: "/etc/docker/certs/server-cert.pem",
          tlskey: "/etc/docker/certs/server-key.pem",
          hosts: ["tcp://0.0.0.0:2376", "unix:///var/run/docker.sock"],
        })
      );
      // il faut enlever les flags de
      // sudo -E systemctl edit docker.service ExecStart=, et ne laisser que le path de dockerd
      // Exemple
      // [Service]
      // ExecStart=
      // ExecStart=/usr/bin/dockerd
      sshClient.exec("systemctl restart docker", (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}
export async function Mkdir(sftp: SFTPWrapper, path: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.mkdir(path, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}
export async function WriteFile(
  sftp: SFTPWrapper,
  path: string,
  content: string
) {
  return new Promise<void>((resolve, reject) => {
    sftp.writeFile(path, content, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

export interface DockerCertificates {
  [key: string]: string;
}
