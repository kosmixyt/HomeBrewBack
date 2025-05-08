import { Router, Request, Response, NextFunction } from 'express';
import { authConfig } from '../utils/config.auth';
import { getSession } from '@auth/express';
import axios from 'axios';
import Dockerode from 'dockerode';

const router = Router();

// Middleware pour vérifier l'authentification
const ensureAuthenticated = async (req: Request, res: Response, next: NextFunction) => {
    const session = await getSession(req, authConfig);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = session.user;
    next();
};

// Route pour faire une requête WHOIS sur un domaine
router.get('/query', ensureAuthenticated, async (req, res) => {
    const { domain } = req.query;

    if (!domain) {
        return res.status(400).json({ error: 'Domain parameter is required' });
    }

    try {
        // Utiliser l'API Layer avec la clé d'API depuis les variables d'environnement
        const response = await fetch(`https://api.apilayer.com/whois/query?domain=${domain}`, {
            headers: {
                'apikey': process.env.API_KEY_LAYER || ''
            },
            redirect: 'follow',
            method: 'GET',
        });
        if (!response.ok) {
            const data = await response.text();
            console.error('Error fetching WHOIS data:', data);
            throw new Error(`Error fetching WHOIS data: ${response.statusText}`);
        }
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error querying WHOIS API:', error);
        res.status(500).json({ error: 'Failed to query WHOIS information' });
    }
});

export { router as whoisRouter };