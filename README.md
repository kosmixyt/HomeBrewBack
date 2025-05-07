# Express.js + TypeScript + Prisma + Session

A template project with Express.js, TypeScript, Prisma ORM, and session management stored directly in the database using Prisma.

## Setup Instructions

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Set up environment variables**:
   - Copy `.env.example` to `.env` (if applicable)
   - Update the `DATABASE_URL` in the `.env` file with your MySQL connection string:
     ```
     DATABASE_URL="mysql://user:password@localhost:3306/myapp"
     ```

3. **Set up the database**:
   - Make sure you have MySQL installed and running
   - Create a database for your application
   ```bash
   npm run prisma:generate
   npm run prisma:migrate
   ```

4. **Start the development server**:
   ```bash
   npm run dev
   ```

5. **Build for production**:
   ```bash
   npm run build
   npm start
   ```

## API Routes

### Authentication
- `POST /auth/register` - Register a new user
- `POST /auth/login` - Log in
- `GET /auth/logout` - Log out
- `GET /auth/status` - Check login status

### User
- `GET /users/profile` - Get user profile (requires authentication)
- `PUT /users/profile` - Update user profile (requires authentication)

## Technologies
- Express.js
- TypeScript
- Prisma ORM with MySQL
- Custom Prisma-based session store
- MySQL database
