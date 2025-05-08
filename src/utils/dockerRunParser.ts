/**
 * Utilité pour convertir une commande docker run en objet de configuration Docker
 */
export function parseDockerRun(command: string): any {
    // Vérifier si la commande commence par 'docker run'
    if (!command.trim().startsWith('docker run')) {
        throw new Error('Not a valid docker run command');
    }

    // Enlever 'docker run' du début
    const argsString = command.replace(/^\s*docker\s+run\s+/, '');

    // Structure pour stocker la configuration
    const config: any = {
        Image: '',
        name: '',
        Env: [],
        ExposedPorts: {},
        HostConfig: {
            PortBindings: {},
            Binds: [],
            RestartPolicy: { Name: 'no' }
        }
    };

    // Analyser les arguments
    const args = tokenizeArgs(argsString);
    let i = 0;

    while (i < args.length) {
        const arg = args[i];

        // Traiter les options
        if (arg.startsWith('-')) {
            if (arg === '-d' || arg === '--detach') {
                // Mode détaché
                config.AttachStdin = false;
                config.AttachStdout = false;
                config.AttachStderr = false;
                config.Tty = false;
                config.OpenStdin = false;
                config.StdinOnce = false;
            } 
            else if (arg === '-it' || arg === '-ti') {
                // Mode interactif avec TTY
                config.AttachStdin = true;
                config.AttachStdout = true;
                config.AttachStderr = true;
                config.Tty = true;
                config.OpenStdin = true;
                config.StdinOnce = true;
            } 
            else if (arg === '-i' || arg === '--interactive') {
                // Mode interactif
                config.AttachStdin = true;
                config.OpenStdin = true;
                config.StdinOnce = true;
            } 
            else if (arg === '-t' || arg === '--tty') {
                // Allouer un pseudo-TTY
                config.Tty = true;
            } 
            else if (arg === '-e' || arg === '--env') {
                // Variable d'environnement
                i++;
                if (i < args.length) {
                    config.Env.push(args[i]);
                }
            } 
            else if (arg === '-p' || arg === '--publish') {
                // Mappage de port
                i++;
                if (i < args.length) {
                    const portMapping = args[i];
                    const [hostPort, containerPort] = portMapping.split(':');
                    
                    // Format pour Docker API
                    let containerPortWithProto = containerPort;
                    if (!containerPortWithProto.includes('/')) {
                        containerPortWithProto += '/tcp';
                    }
                    
                    config.ExposedPorts[containerPortWithProto] = {};
                    config.HostConfig.PortBindings[containerPortWithProto] = [
                        { HostPort: hostPort }
                    ];
                }
            } 
            else if (arg === '-v' || arg === '--volume') {
                // Volume
                i++;
                if (i < args.length) {
                    config.HostConfig.Binds.push(args[i]);
                }
            } 
            else if (arg === '--name') {
                // Nom du conteneur
                i++;
                if (i < args.length) {
                    config.name = args[i];
                }
            } 
            else if (arg === '--restart') {
                // Politique de redémarrage
                i++;
                if (i < args.length) {
                    config.HostConfig.RestartPolicy.Name = args[i];
                }
            }
            // Ajouter d'autres options selon les besoins
        } 
        else {
            // Si ce n'est pas une option, c'est probablement l'image
            if (!config.Image) {
                config.Image = arg;
            }
            // Sinon, ce sont des arguments pour la commande
            else {
                if (!config.Cmd) {
                    config.Cmd = [];
                }
                config.Cmd.push(arg);
            }
        }

        i++;
    }

    return config;
}

/**
 * Divise une chaîne de commande en tokens, en tenant compte des guillemets
 */
function tokenizeArgs(argsString: string): string[] {
    const tokens: string[] = [];
    let currentToken = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    
    for (let i = 0; i < argsString.length; i++) {
        const char = argsString[i];
        
        if (char === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
            continue;
        }
        
        if (char === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            continue;
        }
        
        if (char === ' ' && !inSingleQuote && !inDoubleQuote) {
            if (currentToken) {
                tokens.push(currentToken);
                currentToken = '';
            }
            continue;
        }
        
        currentToken += char;
    }
    
    // Ne pas oublier le dernier token
    if (currentToken) {
        tokens.push(currentToken);
    }
    
    return tokens;
} 