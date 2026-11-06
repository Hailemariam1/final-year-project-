const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.set('trust proxy', 1);

// --- CORS -------------------------------------------------------------------
// FRONTEND_URL may hold one origin or a comma-separated list.
const configuredOrigins = String(process.env.FRONTEND_URL || '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);

const allowedOrigins = Array.from(new Set([
    'https://final-year-project-frontend-silk.vercel.app',
    ...configuredOrigins
]));

function isAllowedOrigin(origin) {
    if (!origin) return true; // curl / server-to-server requests send no Origin
    const normalized = String(origin).replace(/\/+$/, '');
    if (allowedOrigins.includes(normalized)) return true;
    // Vercel preview deployments for this project (e.g. ...-git-main-<hash>.vercel.app)
    if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(normalized)) return true;
    return false;
}

const corsOptions = {
    origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) return callback(null, true);
        // Do not throw: throwing here produced an opaque 500. Rejecting the origin simply
        // omits the CORS headers so the browser blocks the response as expected.
        console.warn('[cors] blocked request from origin:', origin);
        return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    maxAge: 86400
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '5mb' }));

// Initializes Firebase Admin via service module env vars. Has to happen here to avoid a
// circular dependency with the store (which also imports admin).
require('./services/firebaseStore');

// Routes
const authRoutes = require('./routes/authRoutes');
const personRoutes = require('./routes/personRoutes');
const tipRoutes = require('./routes/tipRoutes');
const fileRoutes = require('./routes/fileRoutes');
app.use('/api/auth', authRoutes);
app.use('/api/people', personRoutes);
app.use('/api/tips', tipRoutes);
app.use('/api/files', fileRoutes);

app.get('/', (req, res) => {
    res.send('Missing Person Finder API is running...');
});

// Diagnostic endpoint: never returns secret values, only whether they are configured.
app.get('/api/health', async (req, res) => {
    const aiServiceUrl = String(process.env.AI_SERVICE_URL || '').replace(/\/+$/, '');
    const ai = { configured: Boolean(aiServiceUrl), url: aiServiceUrl || null, reachable: false };

    if (aiServiceUrl) {
        try {
            const response = await fetch(`${aiServiceUrl}/health`, {
                signal: AbortSignal.timeout(8000)
            });
            ai.reachable = response.ok;
            if (response.ok) {
                ai.detail = await response.json().catch(() => null);
            }
        } catch (err) {
            ai.error = err.message;
        }
    }

    res.json({
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        cors: { allowedOrigins },
        env: {
            JWT_SECRET: Boolean(process.env.JWT_SECRET),
            FRONTEND_URL: Boolean(process.env.FRONTEND_URL),
            AI_SERVICE_URL: Boolean(process.env.AI_SERVICE_URL),
            FIREBASE_PROJECT_ID: Boolean(process.env.FIREBASE_PROJECT_ID),
            FIREBASE_DATABASE_URL: Boolean(process.env.FIREBASE_DATABASE_URL),
            FIREBASE_CLIENT_EMAIL: Boolean(process.env.FIREBASE_CLIENT_EMAIL),
            FIREBASE_PRIVATE_KEY: Boolean(process.env.FIREBASE_PRIVATE_KEY)
        },
        ai
    });
});

app.get('/favicon.ico', (req, res) => {
    const favicon = Buffer.from('AAABAAEAEBAAAAAAIABnAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAQAAAAEAgGAAAAH/P/YQAAAC5JREFUeJzt0LERADAMwkDh/XdW7jJCKOPvUUEA1fAoKo2p1hu4htJsgN8/SOIBvVUIG7pVGfsAAAAASUVORK5CYII=', 'base64');
    res.type('image/x-icon');
    res.send(favicon);
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('[server] unhandled error:', err.stack || err.message);

    const requestOrigin = req.headers.origin;
    if (requestOrigin && isAllowedOrigin(requestOrigin)) {
        res.header('Access-Control-Allow-Origin', String(requestOrigin));
        res.header('Access-Control-Allow-Credentials', 'true');
    }

    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ msg: 'Request payload is too large.' });
    }

    res.status(500).json({ msg: err.message || 'Server Error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    const flag = (value) => (value ? 'set' : 'MISSING');
    console.log(`Server running on port ${PORT}`);
    console.log('[config] FRONTEND_URL:', process.env.FRONTEND_URL || '(default)');
    console.log('[config] allowed CORS origins:', allowedOrigins.join(', '));
    console.log('[config] AI_SERVICE_URL:', process.env.AI_SERVICE_URL || '(default)');
    console.log('[config] JWT_SECRET:', flag(process.env.JWT_SECRET));
    console.log('[config] FIREBASE_PROJECT_ID:', flag(process.env.FIREBASE_PROJECT_ID));
    console.log('[config] FIREBASE_CLIENT_EMAIL:', flag(process.env.FIREBASE_CLIENT_EMAIL));
    console.log('[config] FIREBASE_PRIVATE_KEY:', flag(process.env.FIREBASE_PRIVATE_KEY));
    console.log('[config] FIREBASE_DATABASE_URL:', flag(process.env.FIREBASE_DATABASE_URL));
});
