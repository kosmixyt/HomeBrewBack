import { Router, Request, Response, NextFunction } from 'express';
import { authConfig, prisma } from '../utils/config.auth';
import multer from 'multer';
import path from 'path';
import { getSession } from '@auth/express';

const router = Router();
const upload = multer({ dest: path.join(__dirname, '../../uploads') });

declare global {
    namespace Express {
        interface Request {
            user?: { id: string; name: string; email: string }; // Define the user type
        }
    }
}
// Middleware to ensure user is authenticated
const ensureAuthenticated = async (req: Request, res: Response, next: NextFunction) => {
    const session = await getSession(req, authConfig);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = session.user; // Attach user to the request
    next();
};

// Get all categories and items for a user
router.get('/', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.user.id;

        // Get all categories with their items
        const categories = await prisma.selfHostLinkCategory.findMany({
            where: { userId },
            include: { Items: true },
        });

        // Get items without a category
        const uncategorizedItems = await prisma.selfHostItems.findMany({
            where: {
                userId,
                selfHostLinkCategoryId: null
            }
        });

        res.json({
            categories,
            uncategorizedItems
        });
    } catch (error) {
        console.error('Error fetching categories and items:', error);
        res.status(500).json({ error: 'Failed to fetch categories and items' });
    }
});

// Create a new category
router.post('/category', ensureAuthenticated, upload.single('icon'), async (req, res) => {
    try {
        const { name } = req.body;
        const userId = req.user.id;

        // Check if a category with the same name already exists
        const existingCategory = await prisma.selfHostLinkCategory.findFirst({
            where: { userId, name },
        });

        if (existingCategory) {
            return res.status(400).json({ error: 'A category with this name already exists.' });
        }

        let iconPath = '';
        if (req.file) {
            console.log('Category icon uploaded:', req.file);
            const fs = await import('fs/promises');
            const oldPath = req.file.path;
            await fs.rename(oldPath, './uploads/' + req.file.filename);
            iconPath = `./uploads/${req.file.filename}`;
        } else if (req.body.iconPath) {
            iconPath = req.body.iconPath;
        } else {
            iconPath = './uploads/default-folder-icon.png'; // Default icon path
        }

        const category = await prisma.selfHostLinkCategory.create({
            data: { name, iconPath, userId },
        });
        res.json(category);
    } catch (error) {
        console.error('Error creating category:', error);
        res.status(500).json({ error: 'Failed to create category' });
    }
});

// Update a category
router.put('/category/:id', ensureAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, iconPath } = req.body;
        const category = await prisma.selfHostLinkCategory.update({
            where: { id },
            data: { name, iconPath },
        });
        res.json(category);
    } catch (error) {
        console.error('Error updating category:', error);
        res.status(500).json({ error: 'Failed to update category' });
    }
});

// Delete a category
router.delete('/category/:id', ensureAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.selfHostLinkCategory.delete({ where: { id } });
        res.json({ message: 'Category deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete category' });
    }
});

// Create a new item
router.post('/item', ensureAuthenticated, upload.single('icon'), async (req, res) => {
    try {
        const { name, url, selfHostLinkCategoryId } = req.body;
        const userId = req.user!.id;

        let iconPath = '';
        if (req.file) {
            console.log('File uploaded:', req.file);
            const fs = await import('fs/promises');
            const oldPath = req.file.path;
            await fs.rename(oldPath, './uploads/' + req.file.filename);
            iconPath = `./uploads/${req.file.filename}`;
        }

        const item = await prisma.selfHostItems.create({
            data: {
                name,
                url,
                User: { connect: { id: userId } },
                iconPath,
                selfHostLinkCategoryId: selfHostLinkCategoryId,
            },
        });
        res.json(item);
    } catch (error) {
        console.error('Error creating item:', error);
        res.status(500).json({ error: 'Failed to create item' });
    }
});

// Update an item
router.put('/item/:id', ensureAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, url, iconPath } = req.body;
        const item = await prisma.selfHostItems.update({
            where: { id },
            data: { name, url, iconPath },
        });
        res.json(item);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update item' });
    }
});

// Move an item between categories
router.put('/item/:id/move', ensureAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const { categoryId } = req.body;
        const userId = req.user.id;

        // First check that the item belongs to the user
        const item = await prisma.selfHostItems.findFirst({
            where: {
                id,
                userId
            }
        });

        if (!item) {
            return res.status(404).json({ error: 'Item not found' });
        }

        // If categoryId is provided, check that it exists and belongs to the user
        if (categoryId) {
            const category = await prisma.selfHostLinkCategory.findFirst({
                where: {
                    id: categoryId,
                    userId
                }
            });

            if (!category) {
                return res.status(404).json({ error: 'Category not found' });
            }
        }

        // Update item's category
        const updatedItem = await prisma.selfHostItems.update({
            where: { id },
            data: {
                selfHostLinkCategoryId: categoryId
            },
        });

        res.json(updatedItem);
    } catch (error) {
        console.error('Error moving item:', error);
        res.status(500).json({ error: 'Failed to move item' });
    }
});

// Delete an item
router.delete('/item/:id', ensureAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.selfHostItems.delete({ where: { id } });
        res.json({ message: 'Item deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete item' });
    }
});

export { router };
