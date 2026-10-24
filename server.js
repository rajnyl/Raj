const express = require('express');
const path = require('path');
const fs = require('node:fs');
const cors = require('cors');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const postgresUrl = process.env.DATABASE_URL;
const isElectronRuntime = Boolean(process.versions.electron);
if (process.env.NODE_ENV === 'production' && !isElectronRuntime && !postgresUrl) {
    throw new Error('DATABASE_URL is required in production. Configure the Supabase PostgreSQL connection string.');
}
if (process.env.NODE_ENV === 'production' && !isElectronRuntime && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
    throw new Error('SESSION_SECRET must contain at least 32 characters in production.');
}
const usesPostgres = Boolean(postgresUrl);
let sqlite3 = null;
if (!usesPostgres) {
    try {
        sqlite3 = require('sqlite3').verbose();
    } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND' || !error.message.includes("'sqlite3'")) throw error;
        throw new Error(
            'SQLite is not installed. For Render, configure DATABASE_URL to use PostgreSQL; for local development, run npm ci without --omit=optional.',
            { cause: error }
        );
    }
}
const pg = usesPostgres ? require('pg') : null;
const postgresSsl = process.env.PGSSL === 'disable'
    ? false
    : {
        rejectUnauthorized: true,
        ...(process.env.PGSSLROOTCERT
            ? { ca: fs.readFileSync(process.env.PGSSLROOTCERT, 'utf8') }
            : {})
    };
const pgPool = usesPostgres ? new pg.Pool({
    connectionString: postgresUrl,
    ssl: postgresSsl,
    max: 10
}) : null;
const transactionContext = new AsyncLocalStorage();
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_DURATION_SECONDS = 12 * 60 * 60;

const app = express();
const dbPath = process.env.DB_PATH || path.join(__dirname, 'guild_data.sqlite');
const db = usesPostgres ? null : new sqlite3.Database(dbPath, (error) => {
    if (error) console.error('Could not connect to SQLite:', error.message);
    else console.log('Connected to the SQLite database.');
});

app.use(express.json({ limit: '7mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

const readerClients = new Set();
const readerStatusClients = new Set();
const readerState = { name: '', lastSeenAt: 0 };

function toPostgresSql(sql) {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
}

async function bootstrapAdministratorAccount() {
    const roster = await dbAll('SELECT nfc_uid, custom_id, name FROM members');
    const administrators = roster.filter((member) =>
        normalizeGuildId(member.custom_id) === 'NCGG-001' || normalizePersonName(member.name) === 'rajnyl guzman'
    );
    if (administrators.length > 1) throw new Error('The NCGG-001 / Rajnyl Guzman admin identity is ambiguous; resolve the duplicate roster entries first.');
    if (!administrators.length) return;
    const administrator = administrators[0];
    if (normalizeGuildId(administrator.custom_id) !== 'NCGG-001' || normalizePersonName(administrator.name) !== 'rajnyl guzman') {
        throw new Error('Guild ID NCGG-001 must belong to Rajnyl Guzman before assigning the Admin role.');
    }
    await dbRun("UPDATE members SET role = 'Admin' WHERE nfc_uid = ?", [administrator.nfc_uid]);

    const guildId = normalizeGuildId(process.env.BOOTSTRAP_ADMIN_GUILD_ID);
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!guildId && !password) return;
    if (!guildId || typeof password !== 'string' || password.length < 12) {
        throw new Error('Set both BOOTSTRAP_ADMIN_GUILD_ID and a BOOTSTRAP_ADMIN_PASSWORD of at least 12 characters.');
    }
    if (guildId !== 'NCGG-001' || normalizeGuildId(administrator.custom_id) !== guildId) {
        throw new Error('BOOTSTRAP_ADMIN_GUILD_ID must be NCGG-001, assigned to Rajnyl Guzman.');
    }
    const existing = await dbGet('SELECT nfc_uid FROM staff_credentials WHERE nfc_uid = ?', [administrator.nfc_uid]);
    if (existing) return;
    const credentials = await hashPassword(password);
    await dbRun(
        'INSERT INTO staff_credentials (nfc_uid, password_salt, password_hash) VALUES (?, ?, ?)',
        [administrator.nfc_uid, credentials.salt, credentials.hash]
    );
}

function isLocalRequest(req) {
    const address = req.socket.remoteAddress || '';
    return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.0.0.1');
}

function isAuthorizedReaderBridge(req) {
    if (!usesPostgres && isLocalRequest(req)) return true;
    const configuredToken = process.env.READER_BRIDGE_TOKEN || '';
    const providedToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (configuredToken.length < 32 || !providedToken) return false;
    const expected = Buffer.from(configuredToken);
    const provided = Buffer.from(providedToken);
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

function readerIsConnected() {
    return Date.now() - readerState.lastSeenAt < 15000;
}

function broadcastReaderEvent(event) {
    const message = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of readerClients) client.write(message);
    if (event.type === 'status') {
        for (const client of readerStatusClients) client.write(message);
    }
}

app.get('/api/reader/stream', optionalStaff, (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
    });
    res.write(`data: ${JSON.stringify({
        type: 'status',
        connected: readerIsConnected(),
        reader: readerState.name
    })}\n\n`);
    const clients = req.staff ? readerClients : readerStatusClients;
    clients.add(res);
    req.on('close', () => clients.delete(res));
});

app.post('/api/reader/heartbeat', (req, res) => {
    if (!isAuthorizedReaderBridge(req)) return res.status(403).json({ error: 'Reader bridge authentication failed.' });
    const reader = typeof req.body?.reader === 'string' ? req.body.reader.trim() : '';
    if (!reader) return res.status(400).json({ error: 'Reader name is required.' });
    readerState.name = reader;
    readerState.lastSeenAt = Date.now();
    broadcastReaderEvent({ type: 'status', connected: true, reader });
    return res.json({ success: true });
});

app.post('/api/reader/scan', (req, res) => {
    if (!isAuthorizedReaderBridge(req)) return res.status(403).json({ error: 'Reader bridge authentication failed.' });
    const uid = typeof req.body?.nfc_uid === 'string' ? normalizeNfcUid(req.body.nfc_uid) : '';
    if (!uid) return res.status(400).json({ error: 'A card UID is required.' });
    readerState.lastSeenAt = Date.now();
    broadcastReaderEvent({ type: 'scan', uid, reader: readerState.name });
    return res.json({ success: true });
});

function dbRun(sql, params = []) {
    if (usesPostgres) {
        const client = transactionContext.getStore() || pgPool;
        return client.query(toPostgresSql(sql), params)
            .then((result) => ({
                changes: result.rowCount,
                lastID: result.rows[0]?.id
            }));
    }
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (error) {
            if (error) reject(error);
            else resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function dbGet(sql, params = []) {
    if (usesPostgres) {
        const client = transactionContext.getStore() || pgPool;
        return client.query(toPostgresSql(sql), params)
            .then((result) => result.rows[0]);
    }
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });
}

function dbAll(sql, params = []) {
    if (usesPostgres) {
        const client = transactionContext.getStore() || pgPool;
        return client.query(toPostgresSql(sql), params)
            .then((result) => result.rows);
    }
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
}

async function ensureColumn(table, column, declaration) {
    if (usesPostgres) return;
    const columns = await dbAll(`PRAGMA table_info(${table})`);
    if (!columns.some((item) => item.name === column)) {
        await dbRun(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
}

async function initializeDatabase() {
    if (usesPostgres) {
        await pgPool.query(`CREATE TABLE IF NOT EXISTS members (
            nfc_uid TEXT PRIMARY KEY,
            custom_id TEXT UNIQUE,
            name TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('Member', 'Officer', 'Executive', 'Admin')),
            points INTEGER NOT NULL DEFAULT 0,
            tier TEXT NOT NULL DEFAULT 'Regular'
        )`);
        await pgPool.query(`CREATE TABLE IF NOT EXISTS events (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            event_date DATE NOT NULL,
            points INTEGER NOT NULL CHECK (points > 0),
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            closed_at TIMESTAMPTZ
        )`);
        await pgPool.query(`CREATE TABLE IF NOT EXISTS attendance_logs (
            id BIGSERIAL PRIMARY KEY,
            nfc_uid TEXT NOT NULL REFERENCES members(nfc_uid),
            timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            event_name TEXT NOT NULL,
            event_id BIGINT REFERENCES events(id),
            points_awarded INTEGER NOT NULL DEFAULT 10,
            UNIQUE (nfc_uid, event_id)
        )`);
        await pgPool.query(`CREATE TABLE IF NOT EXISTS point_adjustments (
            id BIGSERIAL PRIMARY KEY,
            nfc_uid TEXT NOT NULL REFERENCES members(nfc_uid),
            delta INTEGER NOT NULL CHECK (delta <> 0),
            reason TEXT NOT NULL,
            actor_role TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query(`CREATE TABLE IF NOT EXISTS staff_credentials (
            nfc_uid TEXT PRIMARY KEY REFERENCES members(nfc_uid) ON DELETE CASCADE,
            password_salt TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query('ALTER TABLE public.members DROP CONSTRAINT IF EXISTS members_role_check');
        await pgPool.query(`ALTER TABLE public.members ADD CONSTRAINT members_role_check
            CHECK (role IN ('Member', 'Officer', 'Executive', 'Admin'))`);
        await pgPool.query(`CREATE TABLE IF NOT EXISTS announcements (
            id BIGSERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            author_name TEXT NOT NULL,
            author_role TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query(`CREATE TABLE IF NOT EXISTS event_tasks (
            id BIGSERIAL PRIMARY KEY,
            event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            committee TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            priority TEXT NOT NULL CHECK (priority IN ('Low', 'Medium', 'High')),
            progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
            link_url TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query(`CREATE TABLE IF NOT EXISTS event_task_comments (
            id BIGSERIAL PRIMARY KEY,
            task_id BIGINT NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
            author_name TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query(`CREATE TABLE IF NOT EXISTS event_task_attachments (
            id BIGSERIAL PRIMARY KEY,
            task_id BIGINT NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            content_base64 TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_event_tasks_event_committee ON event_tasks(event_id, committee)');
        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_event_task_comments_task ON event_task_comments(task_id, id)');
        for (const table of [
            'members', 'events', 'attendance_logs', 'point_adjustments', 'staff_credentials',
            'announcements', 'event_tasks', 'event_task_comments', 'event_task_attachments'
        ]) {
            await pgPool.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
        }
        await pgPool.query(`REVOKE ALL ON TABLE public.members, public.events, public.attendance_logs,
            public.point_adjustments, public.staff_credentials, public.announcements, public.event_tasks,
            public.event_task_comments, public.event_task_attachments FROM PUBLIC, anon, authenticated`);
        await pgPool.query(`REVOKE ALL ON SEQUENCE public.events_id_seq, public.attendance_logs_id_seq,
            public.point_adjustments_id_seq FROM PUBLIC, anon, authenticated`);
        await pgPool.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated');
    } else {
        await dbRun(`CREATE TABLE IF NOT EXISTS members (
            nfc_uid TEXT PRIMARY KEY,
            custom_id TEXT,
            name TEXT NOT NULL,
            role TEXT NOT NULL,
            points INTEGER NOT NULL DEFAULT 0,
            tier TEXT NOT NULL DEFAULT 'Regular'
        )`);
        await dbRun(`CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            event_date TEXT NOT NULL,
            points INTEGER NOT NULL CHECK (points > 0),
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await dbRun(`CREATE TABLE IF NOT EXISTS attendance_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nfc_uid TEXT NOT NULL,
            timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            event_name TEXT NOT NULL,
            event_id INTEGER,
            points_awarded INTEGER NOT NULL DEFAULT 10,
            FOREIGN KEY (nfc_uid) REFERENCES members(nfc_uid)
        )`);
        await dbRun(`CREATE TABLE IF NOT EXISTS point_adjustments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nfc_uid TEXT NOT NULL,
            delta INTEGER NOT NULL CHECK (delta != 0),
            reason TEXT NOT NULL,
            actor_role TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (nfc_uid) REFERENCES members(nfc_uid)
        )`);

        await ensureColumn('members', 'custom_id', 'TEXT');
        await ensureColumn('members', 'tier', "TEXT NOT NULL DEFAULT 'Regular'");
        await ensureColumn('events', 'closed_at', 'DATETIME');
        await ensureColumn('attendance_logs', 'event_id', 'INTEGER');
        await ensureColumn('attendance_logs', 'points_awarded', 'INTEGER NOT NULL DEFAULT 10');
        await dbRun('CREATE UNIQUE INDEX IF NOT EXISTS idx_members_custom_id ON members(custom_id) WHERE custom_id IS NOT NULL');
        await dbRun('CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_member_event ON attendance_logs(nfc_uid, event_id) WHERE event_id IS NOT NULL');
        await dbRun(`CREATE TABLE IF NOT EXISTS staff_credentials (
            nfc_uid TEXT PRIMARY KEY,
            password_salt TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (nfc_uid) REFERENCES members(nfc_uid)
        )`);
        await dbRun(`CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            author_name TEXT NOT NULL,
            author_role TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await dbRun(`CREATE TABLE IF NOT EXISTS event_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            committee TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            priority TEXT NOT NULL CHECK (priority IN ('Low', 'Medium', 'High')),
            progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
            link_url TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await dbRun(`CREATE TABLE IF NOT EXISTS event_task_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
            author_name TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await dbRun(`CREATE TABLE IF NOT EXISTS event_task_attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            content_base64 TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await dbRun('CREATE INDEX IF NOT EXISTS idx_event_tasks_event_committee ON event_tasks(event_id, committee)');
        await dbRun('CREATE INDEX IF NOT EXISTS idx_event_task_comments_task ON event_task_comments(task_id, id)');
    }
    await bootstrapAdministratorAccount();
}

// Serialize mutations so point updates and attendance records commit together.
let writeQueue = Promise.resolve();
function withWriteTransaction(work) {
    if (usesPostgres) {
        return (async () => {
            const client = await pgPool.connect();
            let inTransaction = false;
            try {
                await client.query('BEGIN');
                inTransaction = true;
                const result = await transactionContext.run(client, work);
                await client.query('COMMIT');
                inTransaction = false;
                return result;
            } catch (error) {
                if (inTransaction) {
                    try {
                        await client.query('ROLLBACK');
                    } catch (rollbackError) {
                        console.error('Could not roll back the cloud database transaction:', rollbackError.message);
                    }
                }
                throw error;
            } finally {
                client.release();
            }
        })();
    }
    const transaction = writeQueue.then(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            const result = await work();
            await dbRun('COMMIT');
            return result;
        } catch (error) {
            await dbRun('ROLLBACK').catch(() => {});
            throw error;
        }
    });
    writeQueue = transaction.catch(() => {});
    return transaction;
}

function isConstraintError(error) {
    return Boolean(error && error.code && (error.code.startsWith('SQLITE_CONSTRAINT') || error.code === '23505'));
}

function normalizeNfcUid(uid) {
    return String(uid || '').trim().replace(/^0x/i, '').replace(/[\s:-]/g, '').toUpperCase();
}

function normalizeGuildId(value) {
    return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function normalizePersonName(value) {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (error, hash) => {
            if (error) reject(error);
            else resolve({ salt, hash: hash.toString('hex') });
        });
    });
}

function getCookie(req, name) {
    const cookieHeader = req.headers.cookie || '';
    const item = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
    return item ? item.slice(name.length + 1) : '';
}

function signSession(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
}

function readSession(token) {
    if (!token) return null;
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) return null;
    const expected = crypto.createHmac('sha256', sessionSecret).update(encoded).digest();
    let provided;
    try {
        provided = Buffer.from(signature, 'base64url');
    } catch {
        return null;
    }
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
    try {
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        return payload.exp > Math.floor(Date.now() / 1000) && typeof payload.uid === 'string' ? payload : null;
    } catch {
        return null;
    }
}

const loginAttempts = new Map();
function checkLoginRateLimit(req) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const attempts = loginAttempts.get(key);
    if (!attempts || now - attempts.startedAt > 15 * 60 * 1000) {
        loginAttempts.set(key, { startedAt: now, count: 0 });
        return true;
    }
    return attempts.count < 10;
}

function recordFailedLogin(req) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const attempts = loginAttempts.get(key) || { startedAt: Date.now(), count: 0 };
    attempts.count += 1;
    loginAttempts.set(key, attempts);
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `ncgg_staff_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

async function loadStaffFromSession(req, res, next) {
    const session = readSession(getCookie(req, 'ncgg_staff_session'));
    if (!session) return res.status(401).json({ error: 'Sign in with a staff guild ID and password to continue.' });
    try {
        const staff = await dbGet(
            "SELECT nfc_uid, custom_id, name, role FROM members WHERE nfc_uid = ? AND role IN ('Officer', 'Executive', 'Admin')",
            [session.uid]
        );
        if (!staff || (staff.role === 'Admin' &&
            (normalizePersonName(staff.name) !== 'rajnyl guzman' || normalizeGuildId(staff.custom_id) !== 'NCGG-001'))) {
            clearSessionCookie(res);
            return res.status(401).json({ error: 'This staff account is no longer active.' });
        }
        req.staff = { ...staff, role: staff.role.toLowerCase() };
        return next();
    } catch (error) {
        console.error('Could not verify staff session:', error.message);
        return res.status(500).json({ error: 'Could not verify the staff session.' });
    }
}

function requireStaff(req, res, next) {
    const session = readSession(getCookie(req, 'ncgg_staff_session'));
    if (!session) return res.status(401).json({ error: 'Sign in with a staff guild ID and password to continue.' });
    return loadStaffFromSession(req, res, next);
}

function optionalStaff(req, res, next) {
    if (!readSession(getCookie(req, 'ncgg_staff_session'))) return next();
    return loadStaffFromSession(req, res, next);
}

function requireRoles(...roles) {
    return (req, res, next) => {
        if (!req.staff || !roles.includes(req.staff.role)) {
            return res.status(403).json({ error: 'Your staff role is not permitted to perform this action.' });
        }
        return next();
    };
}

app.post('/api/auth/login', async (req, res) => {
    if (!checkLoginRateLimit(req)) {
        return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
    }
    const guildId = normalizeGuildId(req.body?.guild_id);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!guildId || !password || guildId.length > 80 || password.length > 1024) {
        return res.status(400).json({ error: 'Enter your guild ID and password.' });
    }
    try {
        let account = await dbGet(
            `SELECT m.nfc_uid, m.custom_id, m.name, m.role, c.password_salt, c.password_hash
             FROM members m JOIN staff_credentials c ON c.nfc_uid = m.nfc_uid
             WHERE UPPER(m.custom_id) = ? AND m.role IN ('Officer', 'Executive', 'Admin')`,
            [guildId]
        );
        if (account?.role === 'Admin' &&
            (normalizeGuildId(account.custom_id) !== 'NCGG-001' || normalizePersonName(account.name) !== 'rajnyl guzman')) {
            account = null;
        }
        const candidate = await hashPassword(password, account?.password_salt || 'invalid-account-salt');
        const expected = account ? Buffer.from(account.password_hash, 'hex') : Buffer.alloc(64);
        const actual = Buffer.from(candidate.hash, 'hex');
        const valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
        if (!account || !valid) {
            recordFailedLogin(req);
            return res.status(401).json({ error: 'Invalid guild ID or password.' });
        }
        loginAttempts.delete(req.ip || req.socket.remoteAddress || 'unknown');
        const token = signSession({
            uid: account.nfc_uid,
            exp: Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS
        });
        res.setHeader('Set-Cookie', `ncgg_staff_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_SECONDS}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
        return res.json({
            authenticated: true,
            staff: { custom_id: account.custom_id, name: account.name, role: account.role.toLowerCase() }
        });
    } catch (error) {
        console.error('Could not sign in staff account:', error.message);
        return res.status(500).json({ error: 'Could not complete staff sign-in.' });
    }
});

app.get('/api/auth/me', requireStaff, (req, res) => {
    res.json({
        authenticated: true,
        staff: { custom_id: req.staff.custom_id, name: req.staff.name, role: req.staff.role }
    });
});

app.post('/api/auth/logout', (_req, res) => {
    clearSessionCookie(res);
    return res.json({ success: true });
});

app.get('/api/status', (_req, res) => {
    res.json({ database: usesPostgres ? 'cloud' : 'local' });
});

app.get('/api/members', optionalStaff, async (req, res) => {
    try {
        const members = await dbAll('SELECT nfc_uid, custom_id, name, role, points, tier FROM members ORDER BY LOWER(name)');
        if (req.staff?.role === 'admin') return res.json(members);
        return res.json(members.map(({ nfc_uid, ...member }) => member));
    } catch (error) {
        console.error('Could not list members:', error.message);
        res.status(500).json({ error: 'Could not load members.' });
    }
});

app.post('/api/members', requireStaff, async (req, res) => {
    const { nfc_uid, custom_id, name, role, tier } = req.body || {};
    if (role !== 'Member' && !['executive', 'admin'].includes(req.staff.role)) {
        return res.status(403).json({ error: 'Only executives can register officer or executive accounts.' });
    }
    if (![nfc_uid, custom_id, name, role, tier].every((value) => typeof value === 'string' && value.trim())) {
        return res.status(400).json({ error: 'Name, guild ID, role, and NFC card UID are required.' });
    }
    if (!['Member', 'Officer', 'Executive'].includes(role) || !['VIP', 'Member Plus', 'Regular'].includes(tier)) {
        return res.status(400).json({ error: 'Choose a valid guild role and member tier.' });
    }
    const normalizedUid = normalizeNfcUid(nfc_uid);
    if (!normalizedUid) return res.status(400).json({ error: 'Enter a valid NFC card UID.' });

    try {
        await withWriteTransaction(async () => {
            const existingMembers = await dbAll('SELECT nfc_uid FROM members');
            if (existingMembers.some((member) => normalizeNfcUid(member.nfc_uid) === normalizedUid)) {
                const error = new Error('That NFC UID is already registered.');
                error.code = 'SQLITE_CONSTRAINT_UID';
                throw error;
            }
            await dbRun(
                'INSERT INTO members (nfc_uid, custom_id, name, role, points, tier) VALUES (?, ?, ?, ?, 0, ?)',
                [normalizedUid, custom_id.trim().toUpperCase(), name.trim(), role, tier]
            );
        });
        return res.status(201).json({ success: true, message: 'Member registered successfully.' });
    } catch (error) {
        if (isConstraintError(error)) {
            return res.status(409).json({ error: 'That NFC UID or Guild ID is already registered.' });
        }
        console.error('Could not register member:', error.message);
        return res.status(500).json({ error: 'Could not register member.' });
    }
});

app.post('/api/staff/password', requireStaff, requireRoles('admin'), async (req, res) => {
    const guildId = normalizeGuildId(req.body?.guild_id);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!guildId || password.length < 12 || password.length > 1024) {
        return res.status(400).json({ error: 'Enter a staff guild ID and a password of at least 12 characters.' });
    }
    try {
        const target = await dbGet(
            "SELECT nfc_uid FROM members WHERE UPPER(custom_id) = ? AND role IN ('Officer', 'Executive', 'Admin')",
            [guildId]
        );
        if (!target) return res.status(404).json({ error: 'No staff account has that guild ID.' });
        const credentials = await hashPassword(password);
        await withWriteTransaction(async () => {
            const existing = await dbGet('SELECT nfc_uid FROM staff_credentials WHERE nfc_uid = ?', [target.nfc_uid]);
            if (existing) {
                await dbRun(
                    'UPDATE staff_credentials SET password_salt = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE nfc_uid = ?',
                    [credentials.salt, credentials.hash, target.nfc_uid]
                );
            } else {
                await dbRun(
                    'INSERT INTO staff_credentials (nfc_uid, password_salt, password_hash) VALUES (?, ?, ?)',
                    [target.nfc_uid, credentials.salt, credentials.hash]
                );
            }
        });
        return res.json({ success: true });
    } catch (error) {
        console.error('Could not set staff password:', error.message);
        return res.status(500).json({ error: 'Could not set the staff password.' });
    }
});

app.get('/api/points/adjustments', requireStaff, async (_req, res) => {
    try {
        const rows = await dbAll(`SELECT p.id, p.delta, p.reason, p.actor_role, p.created_at,
            m.name AS member_name, m.custom_id
            FROM point_adjustments p
            JOIN members m ON m.nfc_uid = p.nfc_uid
            ORDER BY p.id DESC LIMIT 100`);
        return res.json(rows);
    } catch (error) {
        console.error('Could not load point adjustment history:', error.message);
        return res.status(500).json({ error: 'Could not load point adjustment history.' });
    }
});

app.post('/api/points/adjust', requireStaff, async (req, res) => {
    const { guild_id, amount, direction, reason } = req.body || {};
    const guildId = normalizeGuildId(guild_id);
    const points = Number(amount);
    const cleanReason = typeof reason === 'string' ? reason.trim() : '';
    if (!guildId || !Number.isInteger(points) || points < 1 || points > 1000000 || !['add', 'deduct'].includes(direction) || !cleanReason || cleanReason.length > 300) {
        return res.status(400).json({ error: 'Choose a member, valid point amount and direction, and provide a reason (up to 300 characters).' });
    }

    try {
        const result = await withWriteTransaction(async () => {
            const member = await dbGet(
                `SELECT nfc_uid, name, points FROM members WHERE UPPER(custom_id) = ?${usesPostgres ? ' FOR UPDATE' : ''}`,
                [guildId]
            );
            if (!member) {
                const error = new Error('Selected member was not found.');
                error.status = 404;
                throw error;
            }
            const delta = direction === 'add' ? points : -points;
            const newPoints = Number(member.points) + delta;
            if (newPoints < 0) {
                const error = new Error(`Cannot deduct ${points} points; ${member.name} only has ${member.points} points.`);
                error.status = 400;
                throw error;
            }
            await dbRun('UPDATE members SET points = ? WHERE nfc_uid = ?', [newPoints, member.nfc_uid]);
            await dbRun(
                'INSERT INTO point_adjustments (nfc_uid, delta, reason, actor_role) VALUES (?, ?, ?, ?)',
                [member.nfc_uid, delta, cleanReason, req.staff.role]
            );
            return { member: member.name, delta, newPoints };
        });
        return res.json({ success: true, ...result });
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        console.error('Could not adjust member points:', error.message);
        return res.status(500).json({ error: 'Could not adjust member points.' });
    }
});

app.get('/api/events', async (_req, res) => {
    try {
        res.json(await dbAll('SELECT id, name, event_date, points, closed_at FROM events ORDER BY event_date DESC, id DESC'));
    } catch (error) {
        console.error('Could not list events:', error.message);
        res.status(500).json({ error: 'Could not load events.' });
    }
});

app.get('/api/announcements', async (_req, res) => {
    try {
        return res.json(await dbAll(
            'SELECT id, title, body, author_name, author_role, created_at FROM announcements ORDER BY id DESC LIMIT 100'
        ));
    } catch (error) {
        console.error('Could not load announcements:', error.message);
        return res.status(500).json({ error: 'Could not load announcements.' });
    }
});

app.post('/api/announcements', requireStaff, requireRoles('officer', 'executive', 'admin'), async (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!title || title.length > 160 || !body || body.length > 10000) {
        return res.status(400).json({ error: 'Enter an announcement title (up to 160 characters) and message (up to 10,000 characters).' });
    }
    try {
        let result;
        if (usesPostgres) {
            result = await dbGet(
                'INSERT INTO announcements (title, body, author_name, author_role) VALUES (?, ?, ?, ?) RETURNING id',
                [title, body, req.staff.name, req.staff.role]
            );
        } else {
            result = await dbRun(
                'INSERT INTO announcements (title, body, author_name, author_role) VALUES (?, ?, ?, ?)',
                [title, body, req.staff.name, req.staff.role]
            );
        }
        return res.status(201).json({ success: true, id: result.id || result.lastID });
    } catch (error) {
        console.error('Could not publish announcement:', error.message);
        return res.status(500).json({ error: 'Could not publish announcement.' });
    }
});

const taskStaffRoles = ['officer', 'executive', 'admin'];
const attachmentTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function normalizeTaskLink(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
        const url = new URL(value.trim());
        return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null;
    } catch {
        return null;
    }
}

app.get('/api/tasks', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const eventId = Number(req.query.event_id);
    if (!Number.isInteger(eventId) || eventId < 1) return res.status(400).json({ error: 'Choose a valid event.' });
    try {
        const tasks = await dbAll(
            `SELECT id, event_id, committee, title, description, priority, progress, link_url, created_by, created_at, updated_at
             FROM event_tasks WHERE event_id = ? ORDER BY committee, CASE priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, id`,
            [eventId]
        );
        if (!tasks.length) return res.json([]);
        const taskIds = tasks.map((task) => task.id);
        const comments = await dbAll(
            `SELECT id, task_id, author_name, body, created_at FROM event_task_comments WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY id`,
            taskIds
        );
        const attachments = await dbAll(
            `SELECT id, task_id, filename, mime_type, created_by, created_at FROM event_task_attachments WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY id`,
            taskIds
        );
        return res.json(tasks.map((task) => ({
            ...task,
            comments: comments.filter((comment) => String(comment.task_id) === String(task.id)),
            attachments: attachments.filter((attachment) => String(attachment.task_id) === String(task.id))
        })));
    } catch (error) {
        console.error('Could not load event tasks:', error.message);
        return res.status(500).json({ error: 'Could not load event tasks.' });
    }
});

app.post('/api/tasks', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const eventId = Number(req.body?.event_id);
    const committee = typeof req.body?.committee === 'string' ? req.body.committee.trim() : '';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const priority = req.body?.priority;
    const linkUrl = normalizeTaskLink(req.body?.link_url);
    const progress = Number(req.body?.progress ?? 0);
    if (!Number.isInteger(eventId) || eventId < 1 || !committee || committee.length > 100 ||
        !title || title.length > 160 || description.length > 5000 ||
        !['Low', 'Medium', 'High'].includes(priority) || !Number.isInteger(progress) || progress < 0 || progress > 100 ||
        linkUrl === null || (linkUrl && linkUrl.length > 2000)) {
        return res.status(400).json({ error: 'Enter a valid event, committee, task title, priority, progress, description, and HTTP(S) link.' });
    }
    try {
        const event = await dbGet('SELECT id FROM events WHERE id = ?', [eventId]);
        if (!event) return res.status(404).json({ error: 'Event not found.' });
        let result;
        if (usesPostgres) {
            result = await dbGet(
                `INSERT INTO event_tasks (event_id, committee, title, description, priority, progress, link_url, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                [eventId, committee, title, description, priority, progress, linkUrl, req.staff.name]
            );
        } else {
            result = await dbRun(
                `INSERT INTO event_tasks (event_id, committee, title, description, priority, progress, link_url, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [eventId, committee, title, description, priority, progress, linkUrl, req.staff.name]
            );
        }
        return res.status(201).json({ success: true, id: result.id || result.lastID });
    } catch (error) {
        console.error('Could not create event task:', error.message);
        return res.status(500).json({ error: 'Could not create event task.' });
    }
});

app.patch('/api/tasks/:id', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const taskId = Number(req.params.id);
    const progress = Number(req.body?.progress);
    const priority = req.body?.priority;
    if (!Number.isInteger(taskId) || taskId < 1 || !Number.isInteger(progress) || progress < 0 || progress > 100 ||
        !['Low', 'Medium', 'High'].includes(priority)) {
        return res.status(400).json({ error: 'Provide a valid task ID, progress from 0 to 100, and priority.' });
    }
    try {
        const result = await dbRun(
            'UPDATE event_tasks SET progress = ?, priority = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [progress, priority, taskId]
        );
        if (!result.changes) return res.status(404).json({ error: 'Task not found.' });
        return res.json({ success: true });
    } catch (error) {
        console.error('Could not update event task:', error.message);
        return res.status(500).json({ error: 'Could not update event task.' });
    }
});

app.post('/api/tasks/:id/comments', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const taskId = Number(req.params.id);
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!Number.isInteger(taskId) || taskId < 1 || !body || body.length > 2000) {
        return res.status(400).json({ error: 'Enter a task ID and comment (up to 2,000 characters).' });
    }
    try {
        const task = await dbGet('SELECT id FROM event_tasks WHERE id = ?', [taskId]);
        if (!task) return res.status(404).json({ error: 'Task not found.' });
        await dbRun(
            'INSERT INTO event_task_comments (task_id, author_name, body) VALUES (?, ?, ?)',
            [taskId, req.staff.name, body]
        );
        return res.status(201).json({ success: true });
    } catch (error) {
        console.error('Could not add task comment:', error.message);
        return res.status(500).json({ error: 'Could not add task comment.' });
    }
});

app.post('/api/tasks/:id/attachments', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const taskId = Number(req.params.id);
    const filename = typeof req.body?.filename === 'string' ? req.body.filename.trim().replace(/[\\/\r\n"]/g, '_') : '';
    const mimeType = typeof req.body?.mime_type === 'string' ? req.body.mime_type.toLowerCase() : '';
    const content = typeof req.body?.content_base64 === 'string' ? req.body.content_base64 : '';
    const decodedSize = Buffer.from(content, 'base64').length;
    if (!Number.isInteger(taskId) || taskId < 1 || !filename || filename.length > 180 ||
        !attachmentTypes.has(mimeType) || !content || decodedSize > 5 * 1024 * 1024 ||
        Buffer.from(content, 'base64').toString('base64').replace(/=+$/, '') !== content.replace(/=+$/, '')) {
        return res.status(400).json({ error: 'Attach a PDF or image no larger than 5 MB with a valid filename.' });
    }
    try {
        const task = await dbGet('SELECT id FROM event_tasks WHERE id = ?', [taskId]);
        if (!task) return res.status(404).json({ error: 'Task not found.' });
        await dbRun(
            'INSERT INTO event_task_attachments (task_id, filename, mime_type, content_base64, created_by) VALUES (?, ?, ?, ?, ?)',
            [taskId, filename, mimeType, content, req.staff.name]
        );
        return res.status(201).json({ success: true });
    } catch (error) {
        console.error('Could not upload task attachment:', error.message);
        return res.status(500).json({ error: 'Could not upload task attachment.' });
    }
});

app.get('/api/tasks/:taskId/attachments/:attachmentId', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const taskId = Number(req.params.taskId);
    const attachmentId = Number(req.params.attachmentId);
    if (!Number.isInteger(taskId) || taskId < 1 || !Number.isInteger(attachmentId) || attachmentId < 1) {
        return res.status(400).json({ error: 'Invalid attachment ID.' });
    }
    try {
        const attachment = await dbGet(
            'SELECT filename, mime_type, content_base64 FROM event_task_attachments WHERE id = ? AND task_id = ?',
            [attachmentId, taskId]
        );
        if (!attachment) return res.status(404).json({ error: 'Attachment not found.' });
        const fallback = attachment.filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
        res.setHeader('Content-Type', attachment.mime_type);
        res.setHeader('Content-Disposition', `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        return res.send(Buffer.from(attachment.content_base64, 'base64'));
    } catch (error) {
        console.error('Could not load task attachment:', error.message);
        return res.status(500).json({ error: 'Could not load task attachment.' });
    }
});

app.post('/api/events', requireStaff, async (req, res) => {
    const { name, event_date, points } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || typeof event_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(event_date) || !Number.isInteger(Number(points)) || Number(points) < 1) {
        return res.status(400).json({ error: 'Enter an event name, valid date, and positive whole-number points.' });
    }

    try {
        const result = await withWriteTransaction(async () => {
            if (usesPostgres) {
                return dbGet(
                    'INSERT INTO events (name, event_date, points) VALUES (?, ?, ?) RETURNING id',
                    [name.trim(), event_date, Number(points)]
                );
            }
            const inserted = await dbRun(
                'INSERT INTO events (name, event_date, points) VALUES (?, ?, ?)',
                [name.trim(), event_date, Number(points)]
            );
            return { id: inserted.lastID };
        });
        return res.status(201).json({ success: true, id: result.id });
    } catch (error) {
        console.error('Could not create event:', error.message);
        return res.status(500).json({ error: 'Could not create event.' });
    }
});

app.post('/api/events/:id/close', requireStaff, requireRoles('executive', 'admin'), async (req, res) => {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId) || eventId < 1) return res.status(400).json({ error: 'Invalid event ID.' });

    try {
        await withWriteTransaction(async () => {
            const result = await dbRun(
                'UPDATE events SET closed_at = CURRENT_TIMESTAMP WHERE id = ? AND closed_at IS NULL',
                [eventId]
            );
            if (!result.changes) {
                const existing = await dbGet('SELECT id FROM events WHERE id = ?', [eventId]);
                const error = new Error(existing ? 'This event is already closed.' : 'Event not found.');
                error.status = existing ? 409 : 404;
                throw error;
            }
        });
        return res.json({ success: true });
    } catch (error) {
        return res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not close event.' });
    }
});

app.delete('/api/events/:id', requireStaff, async (req, res) => {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId) || eventId < 1) return res.status(400).json({ error: 'Invalid event ID.' });

    try {
        await withWriteTransaction(async () => {
            const usage = await dbGet('SELECT COUNT(*) AS count FROM attendance_logs WHERE event_id = ?', [eventId]);
            if (Number(usage.count) > 0) {
                const error = new Error('This event already has attendance records and cannot be deleted.');
                error.status = 409;
                throw error;
            }
            await dbRun(
                'DELETE FROM event_task_attachments WHERE task_id IN (SELECT id FROM event_tasks WHERE event_id = ?)',
                [eventId]
            );
            await dbRun(
                'DELETE FROM event_task_comments WHERE task_id IN (SELECT id FROM event_tasks WHERE event_id = ?)',
                [eventId]
            );
            await dbRun('DELETE FROM event_tasks WHERE event_id = ?', [eventId]);
            const result = await dbRun('DELETE FROM events WHERE id = ?', [eventId]);
            if (!result.changes) {
                const error = new Error('Event not found.');
                error.status = 404;
                throw error;
            }
        });
        return res.json({ success: true });
    } catch (error) {
        return res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not delete event.' });
    }
});

app.get('/api/attendance', async (_req, res) => {
    try {
        const logs = await dbAll(`SELECT a.id, a.timestamp, a.event_name, a.points_awarded,
            m.name AS member_name, m.custom_id
            FROM attendance_logs a
            LEFT JOIN members m ON m.nfc_uid = a.nfc_uid
            ORDER BY a.id DESC LIMIT 50`);
        res.json(logs);
    } catch (error) {
        console.error('Could not load attendance:', error.message);
        res.status(500).json({ error: 'Could not load attendance records.' });
    }
});

app.post('/api/attendance', async (req, res) => {
    const { nfc_uid, event_id } = req.body || {};
    const uid = typeof nfc_uid === 'string' ? normalizeNfcUid(nfc_uid) : '';
    const eventId = Number(event_id);
    if (!uid || !Number.isInteger(eventId) || eventId < 1) {
        return res.status(400).json({ error: 'Scan an NFC card and select an event.' });
    }

    try {
        const result = await withWriteTransaction(async () => {
            const member = await dbGet(
                `SELECT nfc_uid, name, points FROM members WHERE nfc_uid = ?${usesPostgres ? ' FOR UPDATE' : ''}`,
                [uid]
            );
            if (!member) {
                const error = new Error('Unregistered card. Ask an officer to add this NFC UID first.');
                error.status = 404;
                throw error;
            }
            const event = await dbGet(
                `SELECT id, name, points, closed_at FROM events WHERE id = ?${usesPostgres ? ' FOR UPDATE' : ''}`,
                [eventId]
            );
            if (!event) {
                const error = new Error('Selected event was not found.');
                error.status = 404;
                throw error;
            }
            if (event.closed_at) {
                const error = new Error('This event is closed and cannot accept check-ins.');
                error.status = 409;
                throw error;
            }
            const existing = await dbGet('SELECT id FROM attendance_logs WHERE nfc_uid = ? AND event_id = ?', [member.nfc_uid, eventId]);
            if (existing) {
                const error = new Error(`${member.name} is already checked in for this event.`);
                error.status = 409;
                throw error;
            }

            await dbRun('UPDATE members SET points = points + ? WHERE nfc_uid = ?', [event.points, member.nfc_uid]);
            await dbRun(
                'INSERT INTO attendance_logs (nfc_uid, event_name, event_id, points_awarded) VALUES (?, ?, ?, ?)',
                [member.nfc_uid, event.name, eventId, event.points]
            );
            return { member: member.name, event: event.name, newPoints: member.points + event.points, pointsAwarded: event.points };
        });
        return res.json({ success: true, ...result });
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        if (isConstraintError(error)) return res.status(409).json({ error: 'This member is already checked in for that event.' });
        console.error('Could not process attendance:', error.message);
        return res.status(500).json({ error: 'Could not process attendance.' });
    }
});

async function startServer(port = process.env.PORT || 3000) {
    await initializeDatabase();
    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            const address = server.address();
            console.log(`NCGG dashboard running at http://localhost:${address.port}`);
            resolve(server);
        });
        server.once('error', reject);
    });
}

function closeDatabase() {
    if (usesPostgres) return pgPool.end();
    return new Promise((resolve, reject) => {
        db.close((error) => {
            if (error) {
                console.error('Could not close the database:', error.message);
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

if (require.main === module) {
    startServer().catch((error) => {
        console.error('Could not start the dashboard:', error.message);
        process.exitCode = 1;
    });
    process.on('SIGINT', () => {
        closeDatabase().then(() => process.exit()).catch(() => {
            process.exitCode = 1;
        });
    });
}

module.exports = { startServer, closeDatabase };
