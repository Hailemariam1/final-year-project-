const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// Middleware
const frontendOrigin = (process.env.FRONTEND_URL || 'https://final-year-project-frontend-silk.vercel.app')
    .replace(/\/+$/, '');
const allowedOrigins = [
    frontendOrigin,
    'https://final-year-project-frontend-silk.vercel.app',
    'https://missingpersonfinder-beryl.vercel.app'
].filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Allow non-browser requests (e.g., curl, server-to-server).
        if (!origin) return callback(null, true);

        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(new Error('CORS not allowed for this origin'));
    },
    credentials: true
}));
app.options('*', cors());
app.use(express.json());

// Initializes Firebase Admin via service module env vars. haile i have to do this here to avoid circular dependency with store which also imports admin
require('./services/firebaseStore');

// Routes
const authRoutes = require('./routes/authRoutes');
const personRoutes = require('./routes/personRoutes');
const tipRoutes = require('./routes/tipRoutes'); // New
const fileRoutes = require('./routes/fileRoutes');
app.use('/api/auth', authRoutes);
app.use('/api/people', personRoutes);
app.use('/api/tips', tipRoutes); // New
app.use('/api/files', fileRoutes);

app.get('/', (req, res) => {
    res.send('Missing Person Finder API is running...');
});

app.get('/favicon.ico', (req, res) => {
    const favicon = Buffer.from('AAABAAEAEBAAAAAAIABnAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAQAAAAEAgGAAAAH/P/YQAAAC5JREFUeJzt0LERADAMwkDh/XdW7jJCKOPvUUEA1fAoKo2p1hu4htJsgN8/SOIBvVUIG7pVGfsAAAAASUVORK5CYII=', 'base64');
    res.type('image/x-icon');
    res.send(favicon);
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    const requestOrigin = req.headers.origin;
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
        res.header('Access-Control-Allow-Origin', requestOrigin);
        res.header('Access-Control-Allow-Credentials', 'true');
    }
    res.status(500).json({ msg: err.message || 'Server Error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
