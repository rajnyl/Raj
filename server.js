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
const announcementReactions = ['👍', '❤️', '🎮', '🔥', '🎉', '👏', '🙌', '😂', '😍', '🤩', '😮', '😢', '🙏', '💯', '🚀', '✅', '👀', '💡', '🏆', '💪'];
const emojiSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
function isValidEmojiReaction(reaction) {
    return typeof reaction === 'string' && reaction.length <= 32 &&
        [...emojiSegmenter.segment(reaction)].length === 1 &&
        /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u.test(reaction);
}

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
        normalizeGuildId(member.custom_id) === 'NCGG-001' || isAdministratorName(member.name)
    );
    if (administrators.length > 1) throw new Error('The NCGG-001 / Rajnyl Guzman admin identity is ambiguous; resolve the duplicate roster entries first.');
    if (!administrators.length) return;
    const administrator = administrators[0];
    if (normalizeGuildId(administrator.custom_id) !== 'NCGG-001' || !isAdministratorName(administrator.name)) {
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
    const clients = ['officer', 'executive', 'admin'].includes(req.staff?.role) ? readerClients : readerStatusClients;
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

app.post('/api/reader/error', (req, res) => {
    if (!isAuthorizedReaderBridge(req)) return res.status(403).json({ error: 'Reader bridge authentication failed.' });
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > 500) return res.status(400).json({ error: 'A reader error message of at most 500 characters is required.' });
    broadcastReaderEvent({ type: 'error', message });
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
            media_type TEXT,
            media_filename TEXT,
            media_data TEXT,
            author_name TEXT NOT NULL,
            author_role TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query('ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS media_type TEXT');
        await pgPool.query('ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS media_filename TEXT');
        await pgPool.query('ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS media_data TEXT');
        await pgPool.query(`CREATE TABLE IF NOT EXISTS announcement_reactions (
            id BIGSERIAL PRIMARY KEY,
            announcement_id BIGINT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
            reactor_id TEXT NOT NULL,
            reaction TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (announcement_id, reactor_id)
        )`);
        await pgPool.query('ALTER TABLE public.announcement_reactions DROP CONSTRAINT IF EXISTS announcement_reactions_reaction_check');
        await pgPool.query(`CREATE TABLE IF NOT EXISTS event_tasks (
            id BIGSERIAL PRIMARY KEY,
            event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
            committee TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            priority TEXT NOT NULL CHECK (priority IN ('Low', 'Medium', 'High')),
            points_reward INTEGER NOT NULL DEFAULT 1 CHECK (points_reward BETWEEN 1 AND 10000),
            progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
            status TEXT NOT NULL DEFAULT 'Not started' CHECK (status IN ('Not started', 'Open', 'Complete')),
            link_url TEXT NOT NULL DEFAULT '',
            deadline DATE,
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query('ALTER TABLE public.event_tasks ALTER COLUMN event_id DROP NOT NULL');
        await pgPool.query('ALTER TABLE public.event_tasks DROP CONSTRAINT IF EXISTS event_tasks_event_id_fkey');
        await pgPool.query('ALTER TABLE public.event_tasks ADD CONSTRAINT event_tasks_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL');
        await pgPool.query('ALTER TABLE public.event_tasks ADD COLUMN IF NOT EXISTS deadline DATE');
        await pgPool.query("ALTER TABLE public.event_tasks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Not started'");
        await pgPool.query('ALTER TABLE public.event_tasks ADD COLUMN IF NOT EXISTS points_reward INTEGER NOT NULL DEFAULT 1');
        await pgPool.query("UPDATE public.event_tasks SET status = CASE WHEN progress >= 100 THEN 'Complete' WHEN progress > 0 THEN 'Open' ELSE 'Not started' END WHERE status = 'Not started' AND progress > 0");
        await pgPool.query(`CREATE TABLE IF NOT EXISTS event_task_assignees (
            task_id BIGINT NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
            guild_id TEXT NOT NULL,
            PRIMARY KEY (task_id, guild_id)
        )`);
        await pgPool.query(`CREATE TABLE IF NOT EXISTS event_task_submissions (
            task_id BIGINT NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
            guild_id TEXT NOT NULL,
            submitted_at TIMESTAMPTZ,
            points_awarded INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (task_id, guild_id)
        )`);
        await pgPool.query('ALTER TABLE public.event_task_submissions ADD COLUMN IF NOT EXISTS points_awarded INTEGER NOT NULL DEFAULT 1');
        await pgPool.query(`CREATE TABLE IF NOT EXISTS event_task_subtasks (
            id BIGSERIAL PRIMARY KEY,
            task_id BIGINT NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            completed BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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
        await pgPool.query(`CREATE TABLE IF NOT EXISTS project_workspaces (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query('ALTER TABLE public.event_tasks ADD COLUMN IF NOT EXISTS workspace_id BIGINT REFERENCES public.project_workspaces(id) ON DELETE SET NULL');
        await pgPool.query(`CREATE TABLE IF NOT EXISTS project_boards (
            id BIGSERIAL PRIMARY KEY,
            workspace_id BIGINT NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query(`CREATE TABLE IF NOT EXISTS project_groups (
            id BIGSERIAL PRIMARY KEY,
            board_id BIGINT NOT NULL REFERENCES project_boards(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query(`CREATE TABLE IF NOT EXISTS project_items (
            id BIGSERIAL PRIMARY KEY,
            group_id BIGINT NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'Not started',
            assignee TEXT NOT NULL DEFAULT '',
            start_date DATE,
            due_date DATE,
            number_value DOUBLE PRECISION,
            text_value TEXT NOT NULL DEFAULT '',
            position INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_project_boards_workspace ON public.project_boards(workspace_id, id)');
        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_project_groups_board ON public.project_groups(board_id, position, id)');
        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_project_items_group ON public.project_items(group_id, position, id)');
        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_event_tasks_workspace ON public.event_tasks(workspace_id)');
        await pgPool.query(`CREATE TABLE IF NOT EXISTS merch_items (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
            inventory INTEGER NOT NULL DEFAULT 0 CHECK (inventory >= 0),
            image_type TEXT,
            image_filename TEXT,
            image_data TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query('ALTER TABLE public.merch_items ADD COLUMN IF NOT EXISTS image_type TEXT');
        await pgPool.query('ALTER TABLE public.merch_items ADD COLUMN IF NOT EXISTS image_filename TEXT');
        await pgPool.query('ALTER TABLE public.merch_items ADD COLUMN IF NOT EXISTS image_data TEXT');
        await pgPool.query("ALTER TABLE public.merch_items ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Accessories'");
        await pgPool.query('ALTER TABLE public.merch_items ADD COLUMN IF NOT EXISTS cost_price_cents INTEGER NOT NULL DEFAULT 0');
        await pgPool.query('ALTER TABLE public.merch_items ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE');
        await pgPool.query('ALTER TABLE public.merch_items ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER NOT NULL DEFAULT 5');
        await pgPool.query(`CREATE TABLE IF NOT EXISTS merch_item_variants (
            id BIGSERIAL PRIMARY KEY,
            item_id BIGINT NOT NULL REFERENCES merch_items(id) ON DELETE CASCADE,
            variant TEXT NOT NULL DEFAULT 'Standard',
            inventory INTEGER NOT NULL DEFAULT 0 CHECK (inventory >= 0),
            UNIQUE (item_id, variant)
        )`);
        await pgPool.query(`INSERT INTO merch_item_variants (item_id, variant, inventory)
            SELECT id, 'Standard', inventory FROM merch_items
            ON CONFLICT (item_id, variant) DO NOTHING`);
        await pgPool.query(`CREATE TABLE IF NOT EXISTS merch_orders (
            id BIGSERIAL PRIMARY KEY,
            order_code TEXT NOT NULL UNIQUE,
            buyer_type TEXT NOT NULL CHECK (buyer_type IN ('member', 'walk-in')),
            buyer_id TEXT,
            buyer_name TEXT NOT NULL,
            subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
            discount_percent INTEGER NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
            discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
            total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
            payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'gcash', 'tab_utang')),
            payment_status TEXT NOT NULL CHECK (payment_status IN ('paid', 'partial', 'unpaid_tab')),
            amount_paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
            fulfillment_status TEXT NOT NULL DEFAULT 'pending_pickup' CHECK (fulfillment_status IN ('pending_pickup', 'completed', 'cancelled')),
            due_date DATE,
            award_points BOOLEAN NOT NULL DEFAULT FALSE,
            points_awarded INTEGER NOT NULL DEFAULT 0,
            cashier_id TEXT NOT NULL,
            cashier_name TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query('ALTER TABLE public.merch_orders ADD COLUMN IF NOT EXISTS points_awarded INTEGER NOT NULL DEFAULT 0');
        await pgPool.query(`CREATE TABLE IF NOT EXISTS merch_order_items (
            id BIGSERIAL PRIMARY KEY,
            order_id BIGINT NOT NULL REFERENCES merch_orders(id) ON DELETE CASCADE,
            item_id BIGINT REFERENCES merch_items(id) ON DELETE SET NULL,
            product_name TEXT NOT NULL,
            variant TEXT NOT NULL,
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
            subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
            category TEXT NOT NULL DEFAULT 'Accessories',
            unit_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0)
        )`);
        await pgPool.query('ALTER TABLE public.merch_order_items ADD COLUMN IF NOT EXISTS category TEXT');
        await pgPool.query('ALTER TABLE public.merch_order_items ADD COLUMN IF NOT EXISTS unit_cost_cents INTEGER');
        await pgPool.query(`UPDATE public.merch_order_items AS item SET
            category = COALESCE(item.category, product.category, 'Accessories'),
            unit_cost_cents = COALESCE(item.unit_cost_cents, product.cost_price_cents, 0)
            FROM public.merch_items AS product
            WHERE item.item_id = product.id AND (item.category IS NULL OR item.unit_cost_cents IS NULL)`);
        await pgPool.query(`UPDATE public.merch_order_items SET
            category = COALESCE(category, 'Accessories'), unit_cost_cents = COALESCE(unit_cost_cents, 0)
            WHERE category IS NULL OR unit_cost_cents IS NULL`);
        await pgPool.query(`CREATE TABLE IF NOT EXISTS merch_order_payments (
            id BIGSERIAL PRIMARY KEY,
            order_id BIGINT NOT NULL REFERENCES merch_orders(id) ON DELETE CASCADE,
            payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'gcash')),
            amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_merch_orders_created ON merch_orders(created_at DESC)');
        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_merch_order_items_order ON merch_order_items(order_id)');
        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_event_tasks_event_committee ON event_tasks(event_id, committee)');
        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_event_task_comments_task ON event_task_comments(task_id, id)');
        for (const table of [
            'members', 'events', 'attendance_logs', 'point_adjustments', 'staff_credentials',
            'announcements', 'announcement_reactions', 'event_tasks', 'event_task_comments', 'event_task_attachments',
            'event_task_assignees', 'event_task_subtasks', 'merch_items', 'merch_item_variants',
            'merch_orders', 'merch_order_items', 'merch_order_payments'
        ]) {
            await pgPool.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
        }
        await pgPool.query(`REVOKE ALL ON TABLE public.members, public.events, public.attendance_logs,
            public.point_adjustments, public.staff_credentials, public.announcements, public.event_tasks,
            public.announcement_reactions, public.event_task_comments, public.event_task_attachments,
            public.event_task_assignees, public.event_task_subtasks, public.merch_items,
            public.merch_item_variants, public.merch_orders, public.merch_order_items,
            public.merch_order_payments FROM PUBLIC, anon, authenticated`);
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
            media_type TEXT,
            media_filename TEXT,
            media_data TEXT,
            author_name TEXT NOT NULL,
            author_role TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await dbRun(`CREATE TABLE IF NOT EXISTS announcement_reactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
            reactor_id TEXT NOT NULL,
            reaction TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (announcement_id, reactor_id)
        )`);
        const reactionTable = await dbGet("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'announcement_reactions'");
        if (reactionTable && /CHECK\s*\(\s*reaction\s+IN/i.test(reactionTable.sql)) {
            await dbRun(`CREATE TABLE announcement_reactions_updated (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
                reactor_id TEXT NOT NULL,
                reaction TEXT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (announcement_id, reactor_id)
            )`);
            await dbRun(`INSERT INTO announcement_reactions_updated (id, announcement_id, reactor_id, reaction, created_at)
                SELECT id, announcement_id, reactor_id, reaction, created_at FROM announcement_reactions`);
            await dbRun('DROP TABLE announcement_reactions');
            await dbRun('ALTER TABLE announcement_reactions_updated RENAME TO announcement_reactions');
        }
        await dbRun(`CREATE TABLE IF NOT EXISTS event_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
            committee TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            priority TEXT NOT NULL CHECK (priority IN ('Low', 'Medium', 'High')),
            points_reward INTEGER NOT NULL DEFAULT 1 CHECK (points_reward BETWEEN 1 AND 10000),
            progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
            status TEXT NOT NULL DEFAULT 'Not started' CHECK (status IN ('Not started', 'Open', 'Complete')),
            link_url TEXT NOT NULL DEFAULT '',
            deadline TEXT,
            created_by TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await ensureColumn('event_tasks', 'deadline', 'TEXT');
        await ensureColumn('event_tasks', 'status', "TEXT NOT NULL DEFAULT 'Not started'");
        await ensureColumn('event_tasks', 'points_reward', 'INTEGER NOT NULL DEFAULT 1');
        const eventTaskColumns = await dbAll('PRAGMA table_info(event_tasks)');
        if (eventTaskColumns.find((column) => column.name === 'event_id')?.notnull) {
            const foreignKeysEnabled = Number((await dbGet('PRAGMA foreign_keys'))?.foreign_keys) === 1;
            await dbRun('PRAGMA foreign_keys = OFF');
            try {
                await dbRun('DROP TABLE IF EXISTS event_tasks_updated');
                await dbRun(`CREATE TABLE event_tasks_updated (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
                committee TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                priority TEXT NOT NULL CHECK (priority IN ('Low', 'Medium', 'High')),
                points_reward INTEGER NOT NULL DEFAULT 1 CHECK (points_reward BETWEEN 1 AND 10000),
                progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
                status TEXT NOT NULL DEFAULT 'Not started' CHECK (status IN ('Not started', 'Open', 'Complete')),
                link_url TEXT NOT NULL DEFAULT '',
                deadline TEXT,
                created_by TEXT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                )`);
                await dbRun(`INSERT INTO event_tasks_updated
                (id, event_id, committee, title, description, priority, points_reward, progress, status, link_url, deadline, created_by, created_at, updated_at)
                SELECT id, event_id, committee, title, description, priority, points_reward, progress, status, link_url, deadline, created_by, created_at, updated_at
                    FROM event_tasks`);
                await dbRun('DROP TABLE event_tasks');
                await dbRun('ALTER TABLE event_tasks_updated RENAME TO event_tasks');
            } finally {
                await dbRun(`PRAGMA foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'}`);
            }
        }
        await dbRun("UPDATE event_tasks SET status = CASE WHEN progress >= 100 THEN 'Complete' WHEN progress > 0 THEN 'Open' ELSE 'Not started' END WHERE status = 'Not started' AND progress > 0");
        await dbRun(`CREATE TABLE IF NOT EXISTS event_task_assignees (
            task_id INTEGER NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
            guild_id TEXT NOT NULL,
            PRIMARY KEY (task_id, guild_id)
        )`);
        await dbRun(`CREATE TABLE IF NOT EXISTS event_task_submissions (
            task_id INTEGER NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
            guild_id TEXT NOT NULL,
            submitted_at DATETIME,
            points_awarded INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (task_id, guild_id)
        )`);
        await ensureColumn('event_task_submissions', 'points_awarded', 'INTEGER NOT NULL DEFAULT 1');
        await dbRun(`CREATE TABLE IF NOT EXISTS event_task_subtasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
        await dbRun(`CREATE TABLE IF NOT EXISTS project_workspaces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await ensureColumn('event_tasks', 'workspace_id', 'INTEGER REFERENCES project_workspaces(id) ON DELETE SET NULL');
        await dbRun(`CREATE TABLE IF NOT EXISTS project_boards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id INTEGER NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await dbRun(`CREATE TABLE IF NOT EXISTS project_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL REFERENCES project_boards(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await dbRun(`CREATE TABLE IF NOT EXISTS project_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'Not started',
            assignee TEXT NOT NULL DEFAULT '',
            start_date TEXT,
            due_date TEXT,
            number_value REAL,
            text_value TEXT NOT NULL DEFAULT '',
            position INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await dbRun('CREATE INDEX IF NOT EXISTS idx_project_boards_workspace ON project_boards(workspace_id, id)');
        await dbRun('CREATE INDEX IF NOT EXISTS idx_project_groups_board ON project_groups(board_id, position, id)');
        await dbRun('CREATE INDEX IF NOT EXISTS idx_project_items_group ON project_items(group_id, position, id)');
        await dbRun('CREATE INDEX IF NOT EXISTS idx_event_tasks_workspace ON event_tasks(workspace_id)');
        await ensureColumn('announcements', 'media_type', 'TEXT');
        await ensureColumn('announcements', 'media_filename', 'TEXT');
        await ensureColumn('announcements', 'media_data', 'TEXT');
        await dbRun(`CREATE TABLE IF NOT EXISTS merch_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
            inventory INTEGER NOT NULL DEFAULT 0 CHECK (inventory >= 0),
            image_type TEXT,
            image_filename TEXT,
            image_data TEXT,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await ensureColumn('merch_items', 'image_type', 'TEXT');
        await ensureColumn('merch_items', 'image_filename', 'TEXT');
        await ensureColumn('merch_items', 'image_data', 'TEXT');
        await ensureColumn('merch_items', 'category', "TEXT NOT NULL DEFAULT 'Accessories'");
        await ensureColumn('merch_items', 'cost_price_cents', 'INTEGER NOT NULL DEFAULT 0');
        await ensureColumn('merch_items', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
        await ensureColumn('merch_items', 'low_stock_threshold', 'INTEGER NOT NULL DEFAULT 5');
        await dbRun(`CREATE TABLE IF NOT EXISTS merch_item_variants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER NOT NULL REFERENCES merch_items(id) ON DELETE CASCADE,
            variant TEXT NOT NULL DEFAULT 'Standard',
            inventory INTEGER NOT NULL DEFAULT 0 CHECK (inventory >= 0),
            UNIQUE (item_id, variant)
        )`);
        await dbRun(`INSERT OR IGNORE INTO merch_item_variants (item_id, variant, inventory)
            SELECT id, 'Standard', inventory FROM merch_items`);
        await dbRun(`CREATE TABLE IF NOT EXISTS merch_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_code TEXT NOT NULL UNIQUE,
            buyer_type TEXT NOT NULL CHECK (buyer_type IN ('member', 'walk-in')),
            buyer_id TEXT,
            buyer_name TEXT NOT NULL,
            subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
            discount_percent INTEGER NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
            discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
            total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
            payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'gcash', 'tab_utang')),
            payment_status TEXT NOT NULL CHECK (payment_status IN ('paid', 'partial', 'unpaid_tab')),
            amount_paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
            fulfillment_status TEXT NOT NULL DEFAULT 'pending_pickup' CHECK (fulfillment_status IN ('pending_pickup', 'completed', 'cancelled')),
            due_date TEXT,
            award_points INTEGER NOT NULL DEFAULT 0,
            points_awarded INTEGER NOT NULL DEFAULT 0,
            cashier_id TEXT NOT NULL,
            cashier_name TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await ensureColumn('merch_orders', 'points_awarded', 'INTEGER NOT NULL DEFAULT 0');
        await dbRun(`CREATE TABLE IF NOT EXISTS merch_order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL REFERENCES merch_orders(id) ON DELETE CASCADE,
            item_id INTEGER REFERENCES merch_items(id) ON DELETE SET NULL,
            product_name TEXT NOT NULL,
            variant TEXT NOT NULL,
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
            subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
            category TEXT NOT NULL DEFAULT 'Accessories',
            unit_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0)
        )`);
        await ensureColumn('merch_order_items', 'category', 'TEXT');
        await ensureColumn('merch_order_items', 'unit_cost_cents', 'INTEGER');
        await dbRun(`UPDATE merch_order_items SET
            category = COALESCE(category, (SELECT category FROM merch_items WHERE merch_items.id = merch_order_items.item_id), 'Accessories'),
            unit_cost_cents = COALESCE(unit_cost_cents, (SELECT cost_price_cents FROM merch_items WHERE merch_items.id = merch_order_items.item_id), 0)
            WHERE category IS NULL OR unit_cost_cents IS NULL`);
        await dbRun(`CREATE TABLE IF NOT EXISTS merch_order_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL REFERENCES merch_orders(id) ON DELETE CASCADE,
            payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'gcash')),
            amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await dbRun('CREATE INDEX IF NOT EXISTS idx_merch_orders_created ON merch_orders(created_at DESC)');
        await dbRun('CREATE INDEX IF NOT EXISTS idx_merch_order_items_order ON merch_order_items(order_id)');
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

function isValidDateString(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isAdministratorName(value) {
    const nameParts = normalizePersonName(value).split(/[,\s]+/).filter(Boolean);
    return nameParts.includes('rajnyl') && nameParts.includes('guzman');
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
    if (!session) return res.status(401).json({ error: 'Sign in with your guild ID and password to continue.' });
    try {
        const staff = await dbGet(
            'SELECT nfc_uid, custom_id, name, role, points, tier FROM members WHERE nfc_uid = ?',
            [session.uid]
        );
        if (!staff || (staff.role === 'Admin' &&
            (!isAdministratorName(staff.name) || normalizeGuildId(staff.custom_id) !== 'NCGG-001'))) {
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
    return loadStaffFromSession(req, res, (error) => {
        if (error) return next(error);
        if (!['officer', 'executive', 'admin'].includes(req.staff?.role)) {
            return res.status(403).json({ error: 'Staff sign-in is required for this action.' });
        }
        return next();
    });
}

function requireAuthenticatedAccount(req, res, next) {
    if (!readSession(getCookie(req, 'ncgg_staff_session'))) {
        return res.status(401).json({ error: 'Sign in with your guild ID and password to continue.' });
    }
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
             WHERE UPPER(m.custom_id) = ?`,
            [guildId]
        );
        if (account?.role === 'Admin' &&
            (normalizeGuildId(account.custom_id) !== 'NCGG-001' || !isAdministratorName(account.name))) {
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

app.get('/api/auth/me', (req, res, next) => {
    if (!readSession(getCookie(req, 'ncgg_staff_session'))) {
        return res.status(401).json({ error: 'Sign in to continue.' });
    }
    return loadStaffFromSession(req, res, next);
}, (req, res) => {
    res.json({
        authenticated: true,
        staff: { custom_id: req.staff.custom_id, name: req.staff.name, role: req.staff.role }
    });
});

app.get('/api/profile', requireAuthenticatedAccount, async (req, res) => {
    try {
        const attendance = await dbAll(
            `SELECT id, timestamp, event_name, event_id, points_awarded
             FROM attendance_logs WHERE nfc_uid = ? ORDER BY id DESC`,
            [req.staff.nfc_uid]
        );
        return res.json({
            profile: {
                name: req.staff.name,
                custom_id: req.staff.custom_id,
                role: req.staff.role,
                points: req.staff.points,
                tier: req.staff.tier
            },
            attendance
        });
    } catch (error) {
        console.error('Could not load personal profile:', error.message);
        return res.status(500).json({ error: 'Could not load your profile.' });
    }
});

app.get('/api/profile/tasks', requireAuthenticatedAccount, async (req, res) => {
    try {
        const tasks = await dbAll(
            `SELECT t.id, t.event_id, e.name AS event_name, t.workspace_id, w.name AS workspace_name,
                t.committee, t.title, t.description, t.priority, t.points_reward, t.progress, t.status,
                t.deadline, t.link_url, t.created_by, t.created_at,
                s.submitted_at IS NOT NULL AS submitted, s.points_awarded
             FROM event_tasks t
             LEFT JOIN events e ON e.id = t.event_id
             LEFT JOIN project_workspaces w ON w.id = t.workspace_id
             JOIN event_task_assignees a ON a.task_id = t.id
             LEFT JOIN event_task_submissions s ON s.task_id = t.id AND UPPER(s.guild_id) = UPPER(a.guild_id)
             WHERE UPPER(a.guild_id) = UPPER(?)
             ORDER BY CASE WHEN t.deadline IS NULL THEN 1 ELSE 0 END, t.deadline, t.id DESC`,
            [req.staff.custom_id]
        );
        return res.json(tasks);
    } catch (error) {
        console.error('Could not load assigned tasks:', error.message);
        return res.status(500).json({ error: 'Could not load your assigned tasks.' });
    }
});

app.post('/api/profile/tasks/:id/submission', requireAuthenticatedAccount, async (req, res) => {
    const taskId = Number(req.params.id);
    const submitted = req.body?.submitted;
    if (!Number.isInteger(taskId) || taskId < 1 || typeof submitted !== 'boolean') {
        return res.status(400).json({ error: 'Provide a valid task ID and submission state.' });
    }
    try {
        const result = await withWriteTransaction(async () => {
            const task = await dbGet(
                `SELECT id, points_reward FROM event_tasks WHERE id = ?${usesPostgres ? ' FOR UPDATE' : ''}`,
                [taskId]
            );
            if (!task) {
                const error = new Error('Task not found.');
                error.status = 404;
                throw error;
            }
            const member = await dbGet(
                `SELECT points FROM members WHERE nfc_uid = ?${usesPostgres ? ' FOR UPDATE' : ''}`,
                [req.staff.nfc_uid]
            );
            const assignment = await dbGet(
                'SELECT task_id FROM event_task_assignees WHERE task_id = ? AND UPPER(guild_id) = UPPER(?)',
                [taskId, req.staff.custom_id]
            );
            if (!assignment) {
                const error = new Error('This task is not assigned to your account.');
                error.status = 403;
                throw error;
            }

            const current = await dbGet(
                'SELECT submitted_at, points_awarded FROM event_task_submissions WHERE task_id = ? AND UPPER(guild_id) = UPPER(?)',
                [taskId, req.staff.custom_id]
            );
            const wasSubmitted = Boolean(current?.submitted_at);
            if (wasSubmitted === submitted) {
                return { submitted, points: Number(member.points), points_delta: 0 };
            }

            if (current) {
                await dbRun(
                    'UPDATE event_task_submissions SET submitted_at = ?, points_awarded = ? WHERE task_id = ? AND UPPER(guild_id) = UPPER(?)',
                    [submitted ? new Date().toISOString() : null, submitted ? Number(task.points_reward) : 0, taskId, req.staff.custom_id]
                );
            } else {
                await dbRun(
                    'INSERT INTO event_task_submissions (task_id, guild_id, submitted_at, points_awarded) VALUES (?, ?, ?, ?)',
                    [taskId, req.staff.custom_id, new Date().toISOString(), Number(task.points_reward)]
                );
            }
            const pointsDelta = submitted ? Number(task.points_reward) : -Number(current.points_awarded || 0);
            await dbRun('UPDATE members SET points = points + ? WHERE nfc_uid = ?', [pointsDelta, req.staff.nfc_uid]);
            return { submitted, points: Number(member.points) + pointsDelta, points_delta: pointsDelta };
        });
        return res.json({ success: true, ...result });
    } catch (error) {
        if (error.status === 403 || error.status === 404) return res.status(error.status).json({ error: error.message });
        console.error('Could not update task submission:', error.message);
        return res.status(500).json({ error: 'Could not update your task submission.' });
    }
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

app.patch('/api/members/:guildId/nfc-card', requireStaff, requireRoles('admin'), async (req, res) => {
    const guildId = normalizeGuildId(req.params.guildId);
    const rawUid = req.body?.nfc_uid;
    const newUid = typeof rawUid === 'string' && rawUid.length <= 128 ? normalizeNfcUid(rawUid) : '';
    if (!guildId || guildId.length > 40 || !newUid) {
        return res.status(400).json({ error: 'Choose an account and enter a valid NFC card UID.' });
    }

    try {
        const replacement = await withWriteTransaction(async () => {
            const target = await dbGet(
                `SELECT nfc_uid, custom_id, name, role, points, tier FROM members
                 WHERE UPPER(custom_id) = ?${usesPostgres ? ' FOR UPDATE' : ''}`,
                [guildId]
            );
            if (!target) {
                const error = new Error('No member or staff account has that guild ID.');
                error.status = 404;
                throw error;
            }

            if (normalizeNfcUid(target.nfc_uid) === newUid) return null;

            const registeredUids = await dbAll('SELECT nfc_uid FROM members');
            if (registeredUids.some((member) => normalizeNfcUid(member.nfc_uid) === newUid)) {
                const error = new Error('That NFC UID is already registered.');
                error.status = 409;
                throw error;
            }

            await dbRun('UPDATE members SET custom_id = NULL WHERE nfc_uid = ?', [target.nfc_uid]);
            await dbRun(
                'INSERT INTO members (nfc_uid, custom_id, name, role, points, tier) VALUES (?, ?, ?, ?, ?, ?)',
                [newUid, target.custom_id, target.name, target.role, target.points, target.tier]
            );
            await dbRun('UPDATE attendance_logs SET nfc_uid = ? WHERE nfc_uid = ?', [newUid, target.nfc_uid]);
            await dbRun('UPDATE point_adjustments SET nfc_uid = ? WHERE nfc_uid = ?', [newUid, target.nfc_uid]);
            await dbRun('UPDATE staff_credentials SET nfc_uid = ? WHERE nfc_uid = ?', [newUid, target.nfc_uid]);
            await dbRun('DELETE FROM members WHERE nfc_uid = ?', [target.nfc_uid]);
            return { oldUid: target.nfc_uid, newUid };
        });

        if (replacement && req.staff.nfc_uid === replacement.oldUid) {
            const session = readSession(getCookie(req, 'ncgg_staff_session'));
            if (session) {
                const token = signSession({ ...session, uid: replacement.newUid });
                const maxAge = Math.max(0, session.exp - Math.floor(Date.now() / 1000));
                res.setHeader(
                    'Set-Cookie',
                    `ncgg_staff_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
                );
            }
        }
        return res.json({ success: true });
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        if (isConstraintError(error)) return res.status(409).json({ error: 'That NFC UID is already registered.' });
        console.error('Could not replace NFC card:', error.message);
        return res.status(500).json({ error: 'Could not replace the NFC card.' });
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
            'SELECT nfc_uid FROM members WHERE UPPER(custom_id) = ?',
            [guildId]
        );
        if (!target) return res.status(404).json({ error: 'No member or staff account has that guild ID.' });
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

app.get('/api/events/:id/attendance-report', requireStaff, async (req, res) => {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId) || eventId < 1) return res.status(400).json({ error: 'Invalid event ID.' });

    try {
        const event = await dbGet('SELECT id, name, event_date FROM events WHERE id = ?', [eventId]);
        if (!event) return res.status(404).json({ error: 'Event not found.' });
        const attendees = await dbAll(`SELECT m.name AS member_name, m.custom_id, a.timestamp
            FROM attendance_logs a
            LEFT JOIN members m ON m.nfc_uid = a.nfc_uid
            WHERE a.event_id = ?
            ORDER BY LOWER(COALESCE(m.name, 'Former member')), a.timestamp`, [eventId]);
        return res.json({ event, attendee_count: attendees.length, attendees });
    } catch (error) {
        console.error('Could not load event attendance report:', error.message);
        return res.status(500).json({ error: 'Could not load event attendance report.' });
    }
});

app.get('/api/merch', optionalStaff, async (req, res) => {
    try {
        const items = await dbAll(`SELECT id, name, description, category, price_cents, cost_price_cents,
            inventory, is_active, low_stock_threshold, image_type, image_filename, updated_at
            FROM merch_items ${req.staff ? '' : 'WHERE is_active = TRUE'} ORDER BY LOWER(name), id`);
        const variants = items.length
            ? await dbAll(`SELECT item_id, variant, inventory FROM merch_item_variants
                WHERE item_id IN (${items.map(() => '?').join(',')}) ORDER BY item_id, variant`, items.map((item) => item.id))
            : [];
        return res.json(items.map((item) => ({
            ...item,
            is_active: item.is_active === true || Number(item.is_active) === 1,
            variants: variants.filter((variant) => String(variant.item_id) === String(item.id))
                .map(({ variant, inventory }) => ({ variant, inventory: Number(inventory) }))
        })));
    } catch (error) {
        console.error('Could not list merchandise:', error.message);
        return res.status(500).json({ error: 'Could not load merchandise.' });
    }
});

app.get('/api/merch/:id/image', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid merchandise item.' });
    try {
        const image = await dbGet('SELECT image_type, image_data FROM merch_items WHERE id = ?', [id]);
        if (!image?.image_data || !image.image_type) return res.status(404).json({ error: 'Merchandise image not found.' });
        res.setHeader('Content-Type', image.image_type);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-cache');
        return res.send(Buffer.from(image.image_data, 'base64'));
    } catch (error) {
        console.error('Could not load merchandise image:', error.message);
        return res.status(500).json({ error: 'Could not load merchandise image.' });
    }
});

function readMerchImage(body) {
    const imageType = typeof body?.image_type === 'string' ? body.image_type : '';
    const imageFilename = typeof body?.image_filename === 'string'
        ? body.image_filename.replace(/[\\/\0]/g, '').slice(0, 180)
        : '';
    const imageData = typeof body?.image_data === 'string' ? body.image_data : '';
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (!imageData && !imageType && !imageFilename) return { imageType: null, imageFilename: null, imageData: null };
    if (!imageData || !allowedTypes.has(imageType) || !imageFilename) {
        return { error: 'Choose a JPEG, PNG, or WebP product image.' };
    }
    const bytes = Buffer.from(imageData, 'base64');
    if (!bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.toString('base64') !== imageData) {
        return { error: 'Product images must be no larger than 5 MB.' };
    }
    return { imageType, imageFilename, imageData };
}

function normalizeMerchVariants(value, fallbackInventory) {
    const variants = Array.isArray(value)
        ? value
        : Number.isSafeInteger(fallbackInventory) && fallbackInventory >= 0
            ? [{ variant: 'Standard', inventory: fallbackInventory }]
            : null;
    if (!variants?.length || variants.length > 40) return null;
    const seen = new Set();
    const normalized = [];
    for (const entry of variants) {
        const variant = typeof entry?.variant === 'string' ? entry.variant.trim() : '';
        const inventory = entry?.inventory;
        const key = variant.toLocaleLowerCase();
        if (!variant || variant.length > 60 || seen.has(key) ||
            !Number.isSafeInteger(inventory) || inventory < 0) return null;
        seen.add(key);
        normalized.push({ variant, inventory });
    }
    return normalized;
}

app.post('/api/merch', requireStaff, requireRoles('admin'), async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const category = typeof req.body?.category === 'string' ? req.body.category.trim() : 'Accessories';
    const priceCents = req.body?.price_cents;
    const costPriceCents = req.body?.cost_price_cents ?? 0;
    const lowStockThreshold = req.body?.low_stock_threshold ?? 5;
    const isActive = req.body?.is_active !== false;
    const variants = normalizeMerchVariants(req.body?.variants, req.body?.inventory);
    const inventory = variants?.reduce((total, variant) => total + variant.inventory, 0);
    const image = readMerchImage(req.body);
    if (!name || name.length > 120 || description.length > 1000 || !category || category.length > 80 ||
        !Number.isSafeInteger(priceCents) || priceCents < 0 ||
        !Number.isSafeInteger(costPriceCents) || costPriceCents < 0 ||
        !Number.isSafeInteger(lowStockThreshold) || lowStockThreshold < 0 ||
        !Number.isSafeInteger(inventory) || inventory < 0) {
        return res.status(400).json({ error: 'Enter a product name, category, non-negative price and cost, and valid variant stock.' });
    }
    if (!variants) return res.status(400).json({ error: 'Enter variant stock as unique variant names with whole-number quantities.' });
    if (image.error) return res.status(400).json({ error: image.error });
    try {
        const inserted = await withWriteTransaction(async () => {
            const result = usesPostgres
                ? await dbGet(`INSERT INTO merch_items
                    (name, description, category, price_cents, cost_price_cents, inventory, is_active, low_stock_threshold, image_type, image_filename, image_data)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                    [name, description, category, priceCents, costPriceCents, inventory, isActive, lowStockThreshold, image.imageType, image.imageFilename, image.imageData])
                : await dbRun(`INSERT INTO merch_items
                    (name, description, category, price_cents, cost_price_cents, inventory, is_active, low_stock_threshold, image_type, image_filename, image_data)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [name, description, category, priceCents, costPriceCents, inventory, isActive ? 1 : 0, lowStockThreshold, image.imageType, image.imageFilename, image.imageData]);
            const id = result.id || result.lastID;
            for (const variant of variants) {
                await dbRun('INSERT INTO merch_item_variants (item_id, variant, inventory) VALUES (?, ?, ?)', [id, variant.variant, variant.inventory]);
            }
            return { id };
        });
        return res.status(201).json({ success: true, id: inserted.id || inserted.lastID });
    } catch (error) {
        console.error('Could not create merchandise item:', error.message);
        return res.status(500).json({ error: 'Could not save merchandise item.' });
    }
});

app.patch('/api/merch/:id', requireStaff, requireRoles('admin'), async (req, res) => {
    const id = Number(req.params.id);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const category = typeof req.body?.category === 'string' ? req.body.category.trim() : 'Accessories';
    const priceCents = req.body?.price_cents;
    const costPriceCents = req.body?.cost_price_cents ?? 0;
    const lowStockThreshold = req.body?.low_stock_threshold ?? 5;
    const isActive = req.body?.is_active !== false;
    const variants = normalizeMerchVariants(req.body?.variants, req.body?.inventory);
    const inventory = variants?.reduce((total, variant) => total + variant.inventory, 0);
    const image = readMerchImage(req.body);
    const removeImage = req.body?.remove_image === true;
    if (!Number.isInteger(id) || id < 1 || !name || name.length > 120 || description.length > 1000 || !category || category.length > 80 ||
        !Number.isSafeInteger(priceCents) || priceCents < 0 ||
        !Number.isSafeInteger(costPriceCents) || costPriceCents < 0 ||
        !Number.isSafeInteger(lowStockThreshold) || lowStockThreshold < 0 ||
        !Number.isSafeInteger(inventory) || inventory < 0) {
        return res.status(400).json({ error: 'Enter a valid product name, category, non-negative price and cost, and variant stock.' });
    }
    if (!variants) return res.status(400).json({ error: 'Enter variant stock as unique variant names with whole-number quantities.' });
    if (image.error) return res.status(400).json({ error: image.error });
    try {
        const updated = await withWriteTransaction(async () => {
            const result = image.imageData
                ? await dbRun(`UPDATE merch_items SET name = ?, description = ?, category = ?, price_cents = ?,
                    cost_price_cents = ?, inventory = ?, is_active = ?, low_stock_threshold = ?,
                    image_type = ?, image_filename = ?, image_data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [name, description, category, priceCents, costPriceCents, inventory, isActive, lowStockThreshold, image.imageType, image.imageFilename, image.imageData, id])
                : await dbRun(`UPDATE merch_items SET name = ?, description = ?, category = ?, price_cents = ?,
                    cost_price_cents = ?, inventory = ?, is_active = ?, low_stock_threshold = ?,
                    image_type = CASE WHEN ? THEN NULL ELSE image_type END,
                    image_filename = CASE WHEN ? THEN NULL ELSE image_filename END,
                    image_data = CASE WHEN ? THEN NULL ELSE image_data END,
                    updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [name, description, category, priceCents, costPriceCents, inventory, isActive, lowStockThreshold,
                    removeImage, removeImage, removeImage, id]);
            if (!result.changes) return result;
            await dbRun('DELETE FROM merch_item_variants WHERE item_id = ?', [id]);
            for (const variant of variants) {
                await dbRun('INSERT INTO merch_item_variants (item_id, variant, inventory) VALUES (?, ?, ?)', [id, variant.variant, variant.inventory]);
            }
            return result;
        });
        if (!updated.changes) return res.status(404).json({ error: 'Merchandise item not found.' });
        return res.json({ success: true });
    } catch (error) {
        console.error('Could not update merchandise item:', error.message);
        return res.status(500).json({ error: 'Could not update merchandise item.' });
    }
});

app.delete('/api/merch/:id', requireStaff, requireRoles('admin'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid merchandise item.' });
    try {
        const deleted = await dbRun('DELETE FROM merch_items WHERE id = ?', [id]);
        if (!deleted.changes) return res.status(404).json({ error: 'Merchandise item not found.' });
        return res.json({ success: true });
    } catch (error) {
        console.error('Could not delete merchandise item:', error.message);
        return res.status(500).json({ error: 'Could not delete merchandise item.' });
    }
});

app.get('/api/pos/orders', requireStaff, async (req, res) => {
    try {
        const orders = await dbAll(`SELECT id, order_code, buyer_type, buyer_id, buyer_name, subtotal_cents,
            discount_percent, discount_cents, total_cents, payment_method, payment_status,
            amount_paid_cents, fulfillment_status, due_date, award_points, points_awarded,
            cashier_id, cashier_name, created_at FROM merch_orders ORDER BY created_at DESC, id DESC`);
        const items = orders.length
            ? await dbAll(`SELECT order_id, product_name, variant, quantity, unit_price_cents, subtotal_cents
                FROM merch_order_items WHERE order_id IN (${orders.map(() => '?').join(',')}) ORDER BY id`, orders.map((order) => order.id))
            : [];
        return res.json(orders.map((order) => ({
            ...order,
            award_points: order.award_points === true || Number(order.award_points) === 1,
            items: items.filter((item) => String(item.order_id) === String(order.id))
        })));
    } catch (error) {
        console.error('Could not load merchandise orders:', error.message);
        return res.status(500).json({ error: 'Could not load merchandise orders.' });
    }
});

app.get('/api/pos/analytics', requireStaff, requireRoles('officer', 'executive', 'admin'), async (_req, res) => {
    try {
        const totals = await dbGet(`SELECT
            (SELECT COUNT(*) FROM merch_orders WHERE fulfillment_status <> 'cancelled') AS orders_count,
            (SELECT COALESCE(SUM(p.amount_cents), 0) FROM merch_order_payments p
                JOIN merch_orders o ON o.id = p.order_id WHERE o.fulfillment_status <> 'cancelled') AS revenue_cents,
            (SELECT COALESCE(SUM(total_cents - amount_paid_cents), 0) FROM merch_orders
                WHERE fulfillment_status <> 'cancelled' AND payment_status <> 'paid') AS outstanding_cents`);
        const bestSellers = await dbAll(`SELECT product_name, SUM(quantity) AS quantity_sold,
            SUM(i.subtotal_cents) AS gross_cents FROM merch_order_items i
            JOIN merch_orders o ON o.id = i.order_id WHERE o.fulfillment_status <> 'cancelled'
            GROUP BY product_name ORDER BY quantity_sold DESC, product_name LIMIT 5`);
        const lowStock = await dbAll(`SELECT p.id, p.name, p.category, SUM(v.inventory) AS inventory,
            p.low_stock_threshold FROM merch_items p JOIN merch_item_variants v ON v.item_id = p.id
            WHERE p.is_active = TRUE GROUP BY p.id, p.name, p.category, p.low_stock_threshold
            HAVING SUM(v.inventory) <= p.low_stock_threshold ORDER BY SUM(v.inventory), LOWER(p.name)`);
        return res.json({ ...totals, best_sellers: bestSellers, low_stock: lowStock });
    } catch (error) {
        console.error('Could not load merchandise analytics:', error.message);
        return res.status(500).json({ error: 'Could not load merchandise analytics.' });
    }
});

app.get('/api/pos/admin-summary', requireStaff, requireRoles('admin'), async (_req, res) => {
    try {
        const lines = await dbAll(`SELECT i.order_id, i.category, i.quantity, i.subtotal_cents, i.unit_cost_cents,
            o.subtotal_cents AS order_subtotal_cents, o.discount_cents
            FROM merch_order_items i JOIN merch_orders o ON o.id = i.order_id
            WHERE o.fulfillment_status <> 'cancelled' ORDER BY i.order_id, i.id`);
        const summaries = new Map();
        let totalQuantity = 0;
        let totalGross = 0n;
        let totalDiscount = 0n;
        let totalCost = 0n;

        for (let start = 0; start < lines.length;) {
            let end = start + 1;
            while (end < lines.length && String(lines[end].order_id) === String(lines[start].order_id)) end++;
            const orderLines = lines.slice(start, end);
            const orderSubtotal = BigInt(orderLines[0].order_subtotal_cents);
            const orderDiscount = BigInt(orderLines[0].discount_cents);
            const allocations = orderLines.map((line) => {
                const gross = BigInt(line.subtotal_cents);
                const numerator = orderSubtotal > 0n ? orderDiscount * gross : 0n;
                return {
                    gross,
                    discount: orderSubtotal > 0n ? numerator / orderSubtotal : 0n,
                    remainder: orderSubtotal > 0n ? numerator % orderSubtotal : 0n
                };
            });
            let undistributedDiscount = orderDiscount - allocations.reduce((sum, allocation) => sum + allocation.discount, 0n);
            const allocationOrder = allocations
                .map((allocation, index) => ({ index, remainder: allocation.remainder }))
                .sort((left, right) => left.remainder > right.remainder ? -1 : left.remainder < right.remainder ? 1 : left.index - right.index);
            for (let index = 0; undistributedDiscount > 0n; index++, undistributedDiscount--) {
                allocations[allocationOrder[index % allocationOrder.length].index].discount++;
            }

            orderLines.forEach((line, index) => {
                const category = String(line.category || 'Accessories').trim() || 'Accessories';
                const quantity = Number(line.quantity);
                const cost = BigInt(line.unit_cost_cents || 0) * BigInt(quantity);
                const allocation = allocations[index];
                const summary = summaries.get(category) || {
                    category, quantity_sold: 0, gross_cents: 0n, discount_cents: 0n,
                    net_sales_cents: 0n, production_cost_cents: 0n, profit_cents: 0n
                };
                const netSales = allocation.gross - allocation.discount;
                summary.quantity_sold += quantity;
                summary.gross_cents += allocation.gross;
                summary.discount_cents += allocation.discount;
                summary.net_sales_cents += netSales;
                summary.production_cost_cents += cost;
                summary.profit_cents += netSales - cost;
                summaries.set(category, summary);
            });
            start = end;
        }

        const safeCents = (value) => {
            const cents = Number(value);
            if (!Number.isSafeInteger(cents)) throw new Error('Merchandise summary exceeds the supported total.');
            return cents;
        };
        const categories = [...summaries.values()].map((summary) => {
            totalQuantity += summary.quantity_sold;
            totalGross += summary.gross_cents;
            totalDiscount += summary.discount_cents;
            totalCost += summary.production_cost_cents;
            return {
                ...summary,
                gross_cents: safeCents(summary.gross_cents),
                discount_cents: safeCents(summary.discount_cents),
                net_sales_cents: safeCents(summary.net_sales_cents),
                production_cost_cents: safeCents(summary.production_cost_cents),
                profit_cents: safeCents(summary.profit_cents)
            };
        }).sort((left, right) => right.net_sales_cents - left.net_sales_cents || left.category.localeCompare(right.category));
        return res.json({
            categories,
            totals: {
                quantity_sold: totalQuantity,
                gross_cents: safeCents(totalGross),
                discount_cents: safeCents(totalDiscount),
                net_sales_cents: safeCents(totalGross - totalDiscount),
                production_cost_cents: safeCents(totalCost),
                profit_cents: safeCents(totalGross - totalDiscount - totalCost)
            }
        });
    } catch (error) {
        console.error('Could not load merchandise profit summary:', error.message);
        return res.status(500).json({ error: 'Could not load merchandise profit summary.' });
    }
});

async function awardPosPoints(order) {
    if (!order.award_points || Number(order.points_awarded) > 0 ||
        order.payment_status !== 'paid' || order.buyer_type !== 'member' || !order.buyer_id) return 0;
    const member = await dbGet('SELECT nfc_uid FROM members WHERE custom_id = ?', [order.buyer_id]);
    const points = Math.floor(Number(order.total_cents) / 10000);
    if (!member || points < 1) return 0;
    await dbRun('UPDATE members SET points = points + ? WHERE nfc_uid = ?', [points, member.nfc_uid]);
    await dbRun(`INSERT INTO point_adjustments (nfc_uid, delta, reason, actor_role)
        VALUES (?, ?, ?, ?)`, [member.nfc_uid, points, `Merchandise order ${order.order_code}`, order.cashier_role || 'staff']);
    await dbRun('UPDATE merch_orders SET points_awarded = ? WHERE id = ?', [points, order.id]);
    return points;
}

app.post('/api/pos/orders', requireStaff, async (req, res) => {
    const buyerType = req.body?.buyer_type;
    const buyerId = typeof req.body?.buyer_id === 'string' ? normalizeGuildId(req.body.buyer_id) : '';
    const buyerNameInput = typeof req.body?.buyer_name === 'string' ? req.body.buyer_name.trim() : '';
    const paymentMethod = req.body?.payment_method;
    const discountPercent = req.body?.discount_percent ?? 0;
    const amountPaidInput = req.body?.amount_paid_cents;
    const dueDate = req.body?.due_date || null;
    const awardPoints = req.body?.award_points === true;
    const rawItems = req.body?.items;
    if (!['member', 'walk-in'].includes(buyerType) ||
        (buyerType === 'member' && !buyerId) || (buyerType === 'walk-in' && (!buyerNameInput || buyerNameInput.length > 120)) ||
        !['cash', 'gcash', 'tab_utang'].includes(paymentMethod) ||
        !Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100 ||
        !Array.isArray(rawItems) || !rawItems.length || rawItems.length > 100) {
        return res.status(400).json({ error: 'Enter a buyer, supported payment method, discount from 0 to 100, and at least one cart item.' });
    }
    const requestedItems = [];
    const itemKeys = new Set();
    for (const item of rawItems) {
        const itemId = Number(item?.product_id);
        const variant = typeof item?.variant === 'string' ? item.variant.trim() : '';
        const quantity = item?.quantity;
        const key = `${itemId}:${variant.toLocaleLowerCase()}`;
        if (!Number.isSafeInteger(itemId) || itemId < 1 || !variant || variant.length > 60 ||
            !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000 || itemKeys.has(key)) {
            return res.status(400).json({ error: 'Cart items must have unique products/variants and whole-number quantities.' });
        }
        itemKeys.add(key);
        requestedItems.push({ itemId, variant, quantity });
    }
    if (dueDate && !isValidDateString(dueDate)) return res.status(400).json({ error: 'Enter a valid tab due date.' });
    try {
        const result = await withWriteTransaction(async () => {
            let buyer = null;
            if (buyerType === 'member') {
                buyer = await dbGet('SELECT custom_id, name, role FROM members WHERE custom_id = ?', [buyerId]);
                if (!buyer) return { error: 'The selected guild member was not found.', status: 404 };
                if (awardPoints && paymentMethod === 'tab_utang') {
                    return { error: 'Merchandise points can be awarded only when the order is paid.', status: 400 };
                }
            }
            const preparedItems = [];
            let subtotalCents = 0;
            for (const requested of requestedItems) {
                const product = await dbGet(`SELECT id, name, category, price_cents, cost_price_cents, is_active FROM merch_items
                    WHERE id = ?${usesPostgres ? ' FOR UPDATE' : ''}`, [requested.itemId]);
                if (!product || !(product.is_active === true || Number(product.is_active) === 1)) {
                    return { error: 'A product in this cart is no longer available.', status: 409 };
                }
                const variantRow = await dbGet(`SELECT inventory FROM merch_item_variants
                    WHERE item_id = ? AND variant = ?${usesPostgres ? ' FOR UPDATE' : ''}`, [requested.itemId, requested.variant]);
                if (!variantRow) return { error: `${product.name} · ${requested.variant} is no longer available.`, status: 409 };
                if (Number(variantRow.inventory) < requested.quantity) {
                    return { error: `Not enough stock for ${product.name} · ${requested.variant}.`, status: 409 };
                }
                const lineTotal = Number(product.price_cents) * requested.quantity;
                if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(subtotalCents + lineTotal)) {
                    return { error: 'This cart total is too large to process.', status: 400 };
                }
                subtotalCents += lineTotal;
                preparedItems.push({
                    ...requested,
                    name: product.name,
                    category: product.category || 'Accessories',
                    unitPriceCents: Number(product.price_cents),
                    unitCostCents: Number(product.cost_price_cents || 0),
                    subtotalCents: lineTotal
                });
            }
            const discountCents = Math.round(subtotalCents * discountPercent / 100);
            const totalCents = subtotalCents - discountCents;
            const amountPaidCents = amountPaidInput === undefined
                ? (paymentMethod === 'tab_utang' ? 0 : totalCents)
                : amountPaidInput;
            if (!Number.isSafeInteger(amountPaidCents) || amountPaidCents < 0 || amountPaidCents > totalCents ||
                (paymentMethod === 'tab_utang' && amountPaidCents !== 0) ||
                (totalCents > 0 && amountPaidCents === 0 && paymentMethod !== 'tab_utang') ||
                (amountPaidCents < totalCents && !dueDate)) {
                return { error: 'Enter a valid amount paid. An unpaid balance requires a due date; use Tab for a fully unpaid order.', status: 400 };
            }
            if (amountPaidCents < totalCents) {
                if (buyerType !== 'member' || !['officer', 'executive'].includes(String(buyer.role).toLowerCase())) {
                    return { error: 'Only linked officers and executives may place an unpaid merch tab.', status: 403 };
                }
            }
            const paymentStatus = amountPaidCents >= totalCents ? 'paid' : amountPaidCents > 0 ? 'partial' : 'unpaid_tab';
            const orderCodePrefix = buyerType === 'walk-in' ? 'WP' : 'GG';
            let orderCode;
            for (let attempt = 0; attempt < 10; attempt++) {
                const candidate = `${orderCodePrefix}${crypto.randomInt(100000, 1000000)}`;
                if (!await dbGet('SELECT id FROM merch_orders WHERE order_code = ?', [candidate])) {
                    orderCode = candidate;
                    break;
                }
            }
            if (!orderCode) throw new Error('Could not generate a unique purchase ID.');
            const buyerName = buyer ? buyer.name : buyerNameInput;
            const insertValues = [
                orderCode, buyerType, buyer ? buyer.custom_id : null, buyerName, subtotalCents,
                discountPercent, discountCents, totalCents, paymentMethod, paymentStatus,
                amountPaidCents, dueDate, awardPoints, req.staff.custom_id, req.staff.name
            ];
            const inserted = usesPostgres
                ? await dbGet(`INSERT INTO merch_orders
                    (order_code, buyer_type, buyer_id, buyer_name, subtotal_cents, discount_percent, discount_cents,
                    total_cents, payment_method, payment_status, amount_paid_cents, due_date, award_points, cashier_id, cashier_name)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                insertValues)
                : await dbRun(`INSERT INTO merch_orders
                    (order_code, buyer_type, buyer_id, buyer_name, subtotal_cents, discount_percent, discount_cents,
                    total_cents, payment_method, payment_status, amount_paid_cents, due_date, award_points, cashier_id, cashier_name)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [...insertValues.slice(0, 12), awardPoints ? 1 : 0, ...insertValues.slice(13)]);
            const orderId = inserted.id || inserted.lastID;
            for (const item of preparedItems) {
                await dbRun(`INSERT INTO merch_order_items
                    (order_id, item_id, product_name, variant, quantity, unit_price_cents, subtotal_cents, category, unit_cost_cents)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [orderId, item.itemId, item.name, item.variant, item.quantity, item.unitPriceCents, item.subtotalCents, item.category, item.unitCostCents]);
                const stockUpdate = await dbRun(`UPDATE merch_item_variants SET inventory = inventory - ?
                    WHERE item_id = ? AND variant = ? AND inventory >= ?`,
                [item.quantity, item.itemId, item.variant, item.quantity]);
                if (!stockUpdate.changes) throw new Error('Merchandise stock changed during checkout.');
                await dbRun('UPDATE merch_items SET inventory = inventory - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [item.quantity, item.itemId]);
            }
            if (amountPaidCents > 0) {
                await dbRun(`INSERT INTO merch_order_payments (order_id, payment_method, amount_cents) VALUES (?, ?, ?)`,
                    [orderId, paymentMethod === 'gcash' ? 'gcash' : 'cash', amountPaidCents]);
            }
            const order = {
                id: orderId, order_code: orderCode, buyer_type: buyerType, buyer_id: buyer?.custom_id || null,
                buyer_name: buyerName, subtotal_cents: subtotalCents, discount_percent: discountPercent,
                discount_cents: discountCents, total_cents: totalCents, payment_method: paymentMethod,
                payment_status: paymentStatus, amount_paid_cents: amountPaidCents, due_date: dueDate,
                award_points: awardPoints, points_awarded: 0, cashier_role: req.staff.role
            };
            const pointsAwarded = await awardPosPoints(order);
            const createdOrder = await dbGet('SELECT created_at FROM merch_orders WHERE id = ?', [orderId]);
            return {
                order_code: orderCode,
                buyer_type: buyerType,
                buyer_id: buyer?.custom_id || null,
                buyer_name: buyerName,
                subtotal_cents: subtotalCents,
                discount_percent: discountPercent,
                discount_cents: discountCents,
                total_cents: totalCents,
                payment_method: paymentMethod,
                payment_status: paymentStatus,
                amount_paid_cents: amountPaidCents,
                due_date: dueDate,
                cashier_id: req.staff.custom_id,
                cashier_name: req.staff.name,
                created_at: createdOrder.created_at,
                items: preparedItems.map((item) => ({
                    product_name: item.name,
                    variant: item.variant,
                    quantity: item.quantity,
                    unit_price_cents: item.unitPriceCents,
                    subtotal_cents: item.subtotalCents
                })),
                points_awarded: pointsAwarded
            };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.status(201).json({ success: true, ...result });
    } catch (error) {
        console.error('Could not process merchandise order:', error.message);
        return res.status(500).json({ error: 'Could not process the merchandise order.' });
    }
});

app.post('/api/pos/orders/:id/payments', requireStaff, async (req, res) => {
    const orderId = Number(req.params.id);
    const amountCents = req.body?.amount_cents;
    const method = req.body?.payment_method;
    if (!Number.isSafeInteger(orderId) || orderId < 1 || !Number.isSafeInteger(amountCents) ||
        amountCents < 1 || !['cash', 'gcash'].includes(method)) {
        return res.status(400).json({ error: 'Enter a valid order, positive payment amount, and cash or GCash method.' });
    }
    try {
        const result = await withWriteTransaction(async () => {
            const order = await dbGet(`SELECT * FROM merch_orders WHERE id = ?${usesPostgres ? ' FOR UPDATE' : ''}`, [orderId]);
            if (!order) return { error: 'Order not found.', status: 404 };
            if (order.fulfillment_status === 'cancelled' || order.payment_status === 'paid') {
                return { error: 'This order cannot accept another payment.', status: 409 };
            }
            if (Number(order.amount_paid_cents) + amountCents > Number(order.total_cents)) {
                return { error: 'Payment exceeds the remaining order balance.', status: 400 };
            }
            await dbRun('INSERT INTO merch_order_payments (order_id, payment_method, amount_cents) VALUES (?, ?, ?)',
                [orderId, method, amountCents]);
            const amountPaid = Number(order.amount_paid_cents) + amountCents;
            const paymentStatus = amountPaid >= Number(order.total_cents) ? 'paid' : 'partial';
            await dbRun('UPDATE merch_orders SET amount_paid_cents = ?, payment_status = ? WHERE id = ?',
                [amountPaid, paymentStatus, orderId]);
            order.amount_paid_cents = amountPaid;
            order.payment_status = paymentStatus;
            order.cashier_role = req.staff.role;
            const pointsAwarded = await awardPosPoints(order);
            return { amount_paid_cents: amountPaid, payment_status: paymentStatus, points_awarded: pointsAwarded };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ success: true, ...result });
    } catch (error) {
        console.error('Could not record merchandise payment:', error.message);
        return res.status(500).json({ error: 'Could not record the merchandise payment.' });
    }
});

app.patch('/api/pos/orders/:id/fulfillment', requireStaff, async (req, res) => {
    const orderId = Number(req.params.id);
    if (!Number.isSafeInteger(orderId) || orderId < 1 || !['completed', 'cancelled'].includes(req.body?.status)) {
        return res.status(400).json({ error: 'Choose a valid order and fulfillment status.' });
    }
    try {
        const result = await withWriteTransaction(async () => {
            const order = await dbGet(`SELECT * FROM merch_orders WHERE id = ?${usesPostgres ? ' FOR UPDATE' : ''}`, [orderId]);
            if (!order) return { error: 'Order not found.', status: 404 };
            if (order.fulfillment_status !== 'pending_pickup') return { error: 'This order has already been finalized.', status: 409 };
            if (req.body.status === 'completed' && order.payment_status !== 'paid') {
                return { error: 'An order must be fully paid before fulfillment.', status: 409 };
            }
            if (req.body.status === 'cancelled') {
                if (Number(order.amount_paid_cents) > 0) {
                    return { error: 'Orders with recorded payments cannot be cancelled until a refund is recorded.', status: 409 };
                }
                const items = await dbAll('SELECT item_id, variant, quantity FROM merch_order_items WHERE order_id = ?', [orderId]);
                for (const item of items) {
                    if (!item.item_id) continue;
                    let restored = await dbRun(`UPDATE merch_item_variants SET inventory = inventory + ?
                        WHERE item_id = ? AND variant = ?`, [item.quantity, item.item_id, item.variant]);
                    if (!restored.changes) {
                        restored = await dbRun('INSERT INTO merch_item_variants (item_id, variant, inventory) VALUES (?, ?, ?)',
                            [item.item_id, item.variant, item.quantity]);
                    }
                    if (restored.changes) {
                        await dbRun('UPDATE merch_items SET inventory = inventory + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                            [item.quantity, item.item_id]);
                    }
                }
            }
            await dbRun('UPDATE merch_orders SET fulfillment_status = ? WHERE id = ?', [req.body.status, orderId]);
            return { success: true };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json(result);
    } catch (error) {
        console.error('Could not update merchandise fulfillment:', error.message);
        return res.status(500).json({ error: 'Could not update merchandise fulfillment.' });
    }
});

const reactorIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

app.get('/api/announcements', async (req, res) => {
    const reactorId = typeof req.query.reactor_id === 'string' ? req.query.reactor_id : '';
    if (reactorId && !reactorIdPattern.test(reactorId)) {
        return res.status(400).json({ error: 'Invalid reaction identity.' });
    }
    try {
        const announcements = await dbAll(
            'SELECT id, title, body, media_type, media_filename, author_name, author_role, created_at FROM announcements ORDER BY id DESC LIMIT 100'
        );
        if (!announcements.length) return res.json([]);
        const ids = announcements.map((announcement) => announcement.id);
        const counts = await dbAll(
            `SELECT announcement_id, reaction, COUNT(*) AS count
             FROM announcement_reactions WHERE announcement_id IN (${ids.map(() => '?').join(',')})
             GROUP BY announcement_id, reaction`,
            ids
        );
        const ownReactions = reactorId
            ? await dbAll(
                `SELECT announcement_id, reaction FROM announcement_reactions
                 WHERE reactor_id = ? AND announcement_id IN (${ids.map(() => '?').join(',')})`,
                [reactorId.toLowerCase(), ...ids]
            )
            : [];
        return res.json(announcements.map((announcement) => {
            const announcementCounts = counts.filter((item) => String(item.announcement_id) === String(announcement.id));
            const knownCounts = announcementReactions.map((reaction) => [
                reaction,
                Number(announcementCounts.find((item) => item.reaction === reaction)?.count || 0)
            ]);
            return {
                ...announcement,
                reaction_counts: Object.fromEntries([
                    ...knownCounts,
                    ...announcementCounts.map((item) => [item.reaction, Number(item.count)])
                ]),
                user_reaction: ownReactions.find((item) => String(item.announcement_id) === String(announcement.id))?.reaction || ''
            };
        }));
    } catch (error) {
        console.error('Could not load announcements:', error.message);
        return res.status(500).json({ error: 'Could not load announcements.' });
    }
});

app.get('/api/announcements/:id/media', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid announcement.' });
    try {
        const media = await dbGet('SELECT media_type, media_data FROM announcements WHERE id = ?', [id]);
        if (!media?.media_data || !media.media_type) return res.status(404).json({ error: 'Announcement media not found.' });
        res.setHeader('Content-Type', media.media_type);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.send(Buffer.from(media.media_data, 'base64'));
    } catch (error) {
        console.error('Could not load announcement media:', error.message);
        return res.status(500).json({ error: 'Could not load announcement media.' });
    }
});

app.post('/api/announcements/:id/reactions', async (req, res) => {
    const announcementId = Number(req.params.id);
    const reactorId = typeof req.body?.reactor_id === 'string' ? req.body.reactor_id.toLowerCase() : '';
    const reaction = req.body?.reaction;
    if (!Number.isInteger(announcementId) || announcementId < 1 || !reactorIdPattern.test(reactorId) ||
        !isValidEmojiReaction(reaction)) {
        return res.status(400).json({ error: 'Choose a valid announcement, reaction, and browser reaction identity.' });
    }
    try {
        const announcement = await dbGet('SELECT id FROM announcements WHERE id = ?', [announcementId]);
        if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
        const existing = await dbGet(
            'SELECT reaction FROM announcement_reactions WHERE announcement_id = ? AND reactor_id = ?',
            [announcementId, reactorId]
        );
        if (existing?.reaction === reaction) {
            await dbRun(
                'DELETE FROM announcement_reactions WHERE announcement_id = ? AND reactor_id = ?',
                [announcementId, reactorId]
            );
            return res.json({ success: true, reaction: '' });
        }
        await dbRun(
            `INSERT INTO announcement_reactions (announcement_id, reactor_id, reaction) VALUES (?, ?, ?)
             ON CONFLICT (announcement_id, reactor_id) DO UPDATE SET reaction = EXCLUDED.reaction, created_at = CURRENT_TIMESTAMP`,
            [announcementId, reactorId, reaction]
        );
        return res.json({ success: true, reaction });
    } catch (error) {
        console.error('Could not save announcement reaction:', error.message);
        return res.status(500).json({ error: 'Could not save announcement reaction.' });
    }
});

app.post('/api/announcements', requireStaff, requireRoles('officer', 'executive', 'admin'), async (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    const mediaType = typeof req.body?.media_type === 'string' ? req.body.media_type : '';
    const mediaFilename = typeof req.body?.media_filename === 'string' ? req.body.media_filename.replace(/[\\/\0]/g, '').slice(0, 180) : '';
    const mediaData = typeof req.body?.media_data === 'string' ? req.body.media_data : '';
    const announcementMediaTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm']);
    const mediaBytes = mediaData ? Buffer.from(mediaData, 'base64') : null;
    if (!title || title.length > 160 || !body || body.length > 10000) {
        return res.status(400).json({ error: 'Enter an announcement title (up to 160 characters) and message (up to 10,000 characters).' });
    }
    if (mediaData && (!announcementMediaTypes.has(mediaType) || !mediaFilename || !mediaBytes.length ||
        mediaBytes.length > 5 * 1024 * 1024 || mediaBytes.toString('base64') !== mediaData)) {
        return res.status(400).json({ error: 'Upload a JPEG, PNG, GIF, WebP, MP4, or WebM file no larger than 5 MB.' });
    }
    try {
        let result;
        if (usesPostgres) {
            result = await dbGet(
                'INSERT INTO announcements (title, body, media_type, media_filename, media_data, author_name, author_role) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
                [title, body, mediaData ? mediaType : null, mediaData ? mediaFilename : null, mediaData || null, req.staff.name, req.staff.role]
            );
        } else {
            result = await dbRun(
                'INSERT INTO announcements (title, body, media_type, media_filename, media_data, author_name, author_role) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [title, body, mediaData ? mediaType : null, mediaData ? mediaFilename : null, mediaData || null, req.staff.name, req.staff.role]
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

function validProjectName(value, limit = 100) {
    return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= limit;
}

app.get('/api/project-workspaces', requireStaff, requireRoles(...taskStaffRoles), async (_req, res) => {
    try {
        return res.json(await dbAll(
            'SELECT id, name, created_at, updated_at FROM project_workspaces ORDER BY LOWER(name), id'
        ));
    } catch (error) {
        console.error('Could not load project workspaces:', error.message);
        return res.status(500).json({ error: 'Could not load project workspaces.' });
    }
});

app.post('/api/project-workspaces', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!validProjectName(name, 100)) return res.status(400).json({ error: 'Enter a workspace name up to 100 characters.' });
    try {
        const inserted = usesPostgres
            ? await dbGet(
                'INSERT INTO project_workspaces (name, created_by) VALUES (?, ?) RETURNING id',
                [name, req.staff.name]
            )
            : await dbRun(
                'INSERT INTO project_workspaces (name, created_by) VALUES (?, ?)',
                [name, req.staff.name]
            );
        return res.status(201).json({ success: true, id: inserted.id || inserted.lastID });
    } catch (error) {
        console.error('Could not create project workspace:', error.message);
        return res.status(500).json({ error: 'Could not create project workspace.' });
    }
});

app.get('/api/project-workspaces/:workspaceId/boards', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const workspaceId = Number(req.params.workspaceId);
    if (!Number.isInteger(workspaceId) || workspaceId < 1) return res.status(400).json({ error: 'Choose a valid workspace.' });
    try {
        return res.json(await dbAll(
            'SELECT id, workspace_id, name, created_at, updated_at FROM project_boards WHERE workspace_id = ? ORDER BY LOWER(name), id',
            [workspaceId]
        ));
    } catch (error) {
        console.error('Could not load project boards:', error.message);
        return res.status(500).json({ error: 'Could not load project boards.' });
    }
});

app.post('/api/project-workspaces/:workspaceId/boards', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const workspaceId = Number(req.params.workspaceId);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!Number.isInteger(workspaceId) || workspaceId < 1 || !validProjectName(name, 120)) {
        return res.status(400).json({ error: 'Choose a workspace and enter a board name up to 120 characters.' });
    }
    try {
        const result = await withWriteTransaction(async () => {
            if (!await dbGet('SELECT id FROM project_workspaces WHERE id = ?', [workspaceId])) {
                const error = new Error('Workspace not found.');
                error.status = 404;
                throw error;
            }
            const inserted = usesPostgres
                ? await dbGet(
                    'INSERT INTO project_boards (workspace_id, name, created_by) VALUES (?, ?, ?) RETURNING id',
                    [workspaceId, name, req.staff.name]
                )
                : await dbRun(
                    'INSERT INTO project_boards (workspace_id, name, created_by) VALUES (?, ?, ?)',
                    [workspaceId, name, req.staff.name]
                );
            const boardId = inserted.id || inserted.lastID;
            await dbRun('INSERT INTO project_groups (board_id, name, position) VALUES (?, ?, 0)', [boardId, 'To do']);
            return { id: boardId };
        });
        return res.status(201).json({ success: true, id: result.id });
    } catch (error) {
        if (error.status === 404) return res.status(404).json({ error: error.message });
        console.error('Could not create project board:', error.message);
        return res.status(500).json({ error: 'Could not create project board.' });
    }
});

app.get('/api/project-boards/:boardId', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const boardId = Number(req.params.boardId);
    if (!Number.isInteger(boardId) || boardId < 1) return res.status(400).json({ error: 'Choose a valid board.' });
    try {
        const board = await dbGet(
            'SELECT id, workspace_id, name, created_at, updated_at FROM project_boards WHERE id = ?',
            [boardId]
        );
        if (!board) return res.status(404).json({ error: 'Board not found.' });
        const groups = await dbAll(
            'SELECT id, board_id, name, position FROM project_groups WHERE board_id = ? ORDER BY position, id',
            [boardId]
        );
        if (!groups.length) return res.json({ ...board, groups: [] });
        const items = await dbAll(
            `SELECT id, group_id, title, status, assignee, start_date, due_date, number_value, text_value, position, created_at, updated_at
             FROM project_items WHERE group_id IN (${groups.map(() => '?').join(',')}) ORDER BY position, id`,
            groups.map((group) => group.id)
        );
        return res.json({
            ...board,
            groups: groups.map((group) => ({
                ...group,
                items: items.filter((item) => String(item.group_id) === String(group.id))
            }))
        });
    } catch (error) {
        console.error('Could not load project board:', error.message);
        return res.status(500).json({ error: 'Could not load project board.' });
    }
});

app.post('/api/project-boards/:boardId/groups', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const boardId = Number(req.params.boardId);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!Number.isInteger(boardId) || boardId < 1 || !validProjectName(name, 100)) {
        return res.status(400).json({ error: 'Choose a board and enter a group name up to 100 characters.' });
    }
    try {
        if (!await dbGet('SELECT id FROM project_boards WHERE id = ?', [boardId])) return res.status(404).json({ error: 'Board not found.' });
        const position = Number((await dbGet('SELECT COUNT(*) AS count FROM project_groups WHERE board_id = ?', [boardId]))?.count || 0);
        const inserted = usesPostgres
            ? await dbGet('INSERT INTO project_groups (board_id, name, position) VALUES (?, ?, ?) RETURNING id', [boardId, name, position])
            : await dbRun('INSERT INTO project_groups (board_id, name, position) VALUES (?, ?, ?)', [boardId, name, position]);
        return res.status(201).json({ success: true, id: inserted.id || inserted.lastID });
    } catch (error) {
        console.error('Could not create project group:', error.message);
        return res.status(500).json({ error: 'Could not create project group.' });
    }
});

app.post('/api/project-groups/:groupId/items', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const groupId = Number(req.params.groupId);
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!Number.isInteger(groupId) || groupId < 1 || !validProjectName(title, 160)) {
        return res.status(400).json({ error: 'Choose a group and enter an item name up to 160 characters.' });
    }
    try {
        if (!await dbGet('SELECT id FROM project_groups WHERE id = ?', [groupId])) return res.status(404).json({ error: 'Group not found.' });
        const position = Number((await dbGet('SELECT COUNT(*) AS count FROM project_items WHERE group_id = ?', [groupId]))?.count || 0);
        const inserted = usesPostgres
            ? await dbGet('INSERT INTO project_items (group_id, title, position) VALUES (?, ?, ?) RETURNING id', [groupId, title, position])
            : await dbRun('INSERT INTO project_items (group_id, title, position) VALUES (?, ?, ?)', [groupId, title, position]);
        return res.status(201).json({ success: true, id: inserted.id || inserted.lastID });
    } catch (error) {
        console.error('Could not create project item:', error.message);
        return res.status(500).json({ error: 'Could not create project item.' });
    }
});

app.patch('/api/project-items/:itemId', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const itemId = Number(req.params.itemId);
    const body = req.body || {};
    if (!Number.isInteger(itemId) || itemId < 1) return res.status(400).json({ error: 'Choose a valid item.' });
    const changes = [];
    const values = [];
    const set = (column, value) => { changes.push(`${column} = ?`); values.push(value); };
    if (Object.hasOwn(body, 'title')) {
        if (!validProjectName(body.title, 160)) return res.status(400).json({ error: 'Item name is required and must be at most 160 characters.' });
        set('title', body.title.trim());
    }
    if (Object.hasOwn(body, 'status')) {
        if (!['Not started', 'Working on it', 'Stuck', 'Done'].includes(body.status)) {
            return res.status(400).json({ error: 'Choose Not started, Working on it, Stuck, or Done.' });
        }
        set('status', body.status.trim());
    }
    if (Object.hasOwn(body, 'assignee')) {
        if (typeof body.assignee !== 'string' || body.assignee.length > 100) return res.status(400).json({ error: 'Assignee must be a staff guild ID.' });
        if (body.assignee.trim()) {
            const validAssignee = await dbGet(
                "SELECT custom_id FROM members WHERE role IN ('Officer', 'Executive', 'Admin') AND UPPER(custom_id) = UPPER(?)",
                [body.assignee.trim()]
            );
            if (!validAssignee) return res.status(400).json({ error: 'Choose a current staff member.' });
        }
        set('assignee', body.assignee.trim());
    }
    for (const column of ['start_date', 'due_date']) {
        if (!Object.hasOwn(body, column)) continue;
        const date = body[column] === '' || body[column] === null ? null : body[column];
        if (date !== null && (typeof date !== 'string' || !isValidDateString(date))) return res.status(400).json({ error: 'Enter a valid start or due date.' });
        set(column, date);
    }
    if (!changes.length) return res.status(400).json({ error: 'Provide at least one item field to update.' });
    try {
        const updated = await dbRun(
            `UPDATE project_items SET ${changes.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [...values, itemId]
        );
        if (!updated.changes) return res.status(404).json({ error: 'Item not found.' });
        return res.json({ success: true });
    } catch (error) {
        console.error('Could not update project item:', error.message);
        return res.status(500).json({ error: 'Could not update project item.' });
    }
});

app.get('/api/tasks', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const eventId = req.query.event_id ? Number(req.query.event_id) : null;
    if (eventId !== null && (!Number.isInteger(eventId) || eventId < 1)) return res.status(400).json({ error: 'Choose a valid event.' });
    try {
        const tasks = await dbAll(
            `SELECT t.id, t.event_id, e.name AS event_name, t.workspace_id, w.name AS workspace_name,
                t.committee, t.title, t.description, t.priority, t.points_reward,
                t.progress, t.status, t.deadline, t.link_url, t.created_by, t.created_at, t.updated_at
             FROM event_tasks t LEFT JOIN events e ON e.id = t.event_id
             LEFT JOIN project_workspaces w ON w.id = t.workspace_id
             ${eventId === null ? '' : 'WHERE t.event_id = ?'}
             ORDER BY COALESCE(e.name, 'General tasks'), t.committee,
                CASE t.priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, t.id`,
            eventId === null ? [] : [eventId]
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
        const assignees = await dbAll(
            `SELECT task_id, guild_id FROM event_task_assignees WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY guild_id`,
            taskIds
        );
        const subtasks = await dbAll(
            `SELECT id, task_id, title, completed FROM event_task_subtasks WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY id`,
            taskIds
        );
        return res.json(tasks.map((task) => ({
            ...task,
            comments: comments.filter((comment) => String(comment.task_id) === String(task.id)),
            attachments: attachments.filter((attachment) => String(attachment.task_id) === String(task.id)),
            assignees: assignees.filter((assignee) => String(assignee.task_id) === String(task.id)).map((assignee) => assignee.guild_id),
            subtasks: subtasks.filter((subtask) => String(subtask.task_id) === String(task.id))
        })));
    } catch (error) {
        console.error('Could not load event tasks:', error.message);
        return res.status(500).json({ error: 'Could not load event tasks.' });
    }
});

app.post('/api/tasks', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const eventId = req.body?.event_id ? Number(req.body.event_id) : null;
    const workspaceId = req.body?.workspace_id ? Number(req.body.workspace_id) : null;
    const committee = typeof req.body?.committee === 'string' ? req.body.committee.trim() : '';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const priority = req.body?.priority;
    const pointsReward = req.body?.points_reward ?? 1;
    const status = req.body?.status || (Number(req.body?.progress) >= 100 ? 'Complete' : Number(req.body?.progress) > 0 ? 'Open' : 'Not started');
    const linkUrl = normalizeTaskLink(req.body?.link_url);
    const progress = status === 'Complete' ? 100 : status === 'Open' ? 50 : Number(req.body?.progress ?? 0);
    const deadline = typeof req.body?.deadline === 'string' && req.body.deadline ? req.body.deadline : null;
    if ((eventId !== null && (!Number.isInteger(eventId) || eventId < 1)) ||
        (workspaceId !== null && (!Number.isInteger(workspaceId) || workspaceId < 1)) ||
        !Number.isSafeInteger(pointsReward) || pointsReward < 1 || pointsReward > 10000 ||
        !committee || committee.length > 100 ||
        !title || title.length > 160 || description.length > 5000 ||
        !['Low', 'Medium', 'High'].includes(priority) || !['Not started', 'Open', 'Complete'].includes(status) ||
        !Number.isInteger(progress) || progress < 0 || progress > 100 ||
        linkUrl === null || (linkUrl && linkUrl.length > 2000) || (deadline && !isValidDateString(deadline))) {
        return res.status(400).json({ error: 'Enter a valid event, committee, task title, priority, progress, deadline, description, and HTTP(S) link.' });
    }
    try {
        if (eventId !== null && !await dbGet('SELECT id FROM events WHERE id = ?', [eventId])) {
            return res.status(404).json({ error: 'Event not found.' });
        }
        if (workspaceId !== null && !await dbGet('SELECT id FROM project_workspaces WHERE id = ?', [workspaceId])) {
            return res.status(404).json({ error: 'Workspace not found.' });
        }
        const guildIds = req.body?.assignees ?? [];
        if (!Array.isArray(guildIds) || guildIds.length > 20 || guildIds.some((guildId) => typeof guildId !== 'string' || !guildId.trim() || guildId.length > 40) ||
            new Set(guildIds.map((guildId) => guildId.toUpperCase())).size !== guildIds.length) {
            return res.status(400).json({ error: 'Choose up to 20 distinct member assignees.' });
        }
        if (guildIds.length) {
            const validAssignees = await dbAll(
                `SELECT custom_id FROM members WHERE custom_id IS NOT NULL AND UPPER(custom_id) IN (${guildIds.map(() => 'UPPER(?)').join(',')})`,
                guildIds
            );
            if (validAssignees.length !== guildIds.length) return res.status(400).json({ error: 'One or more assignees are not current guild members.' });
        }
        const result = await withWriteTransaction(async () => {
            let inserted;
            if (usesPostgres) {
                inserted = await dbGet(
                    `INSERT INTO event_tasks (event_id, workspace_id, committee, title, description, priority, points_reward, progress, status, deadline, link_url, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                    [eventId, workspaceId, committee, title, description, priority, pointsReward, progress, status, deadline, linkUrl, req.staff.name]
                );
            } else {
                inserted = await dbRun(
                    `INSERT INTO event_tasks (event_id, workspace_id, committee, title, description, priority, points_reward, progress, status, deadline, link_url, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [eventId, workspaceId, committee, title, description, priority, pointsReward, progress, status, deadline, linkUrl, req.staff.name]
                );
            }
            const id = inserted.id || inserted.lastID;
            for (const guildId of guildIds) {
                await dbRun('INSERT INTO event_task_assignees (task_id, guild_id) VALUES (?, ?)', [id, guildId]);
            }
            return { id };
        });
        return res.status(201).json({ success: true, id: result.id || result.lastID });
    } catch (error) {
        console.error('Could not create event task:', error.message);
        return res.status(500).json({ error: 'Could not create event task.' });
    }
});

app.patch('/api/tasks/:id', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const taskId = Number(req.params.id);
    const body = req.body || {};
    if (!Number.isInteger(taskId) || taskId < 1) return res.status(400).json({ error: 'Provide a valid task ID.' });
    const changes = [];
    const values = [];
    const set = (column, value) => { changes.push(`${column} = ?`); values.push(value); };
    if (Object.hasOwn(body, 'title')) {
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 160) return res.status(400).json({ error: 'Task title is required and must be at most 160 characters.' });
        set('title', body.title.trim());
    }
    if (Object.hasOwn(body, 'committee')) {
        if (typeof body.committee !== 'string' || !body.committee.trim() || body.committee.trim().length > 100) return res.status(400).json({ error: 'Committee is required and must be at most 100 characters.' });
        set('committee', body.committee.trim());
    }
    if (Object.hasOwn(body, 'description')) {
        if (typeof body.description !== 'string' || body.description.length > 5000) return res.status(400).json({ error: 'Task details must be at most 5,000 characters.' });
        set('description', body.description.trim());
    }
    if (Object.hasOwn(body, 'points_reward')) {
        if (!Number.isSafeInteger(body.points_reward) || body.points_reward < 1 || body.points_reward > 10000) {
            return res.status(400).json({ error: 'Quest rewards must be a whole number between 1 and 10,000 points.' });
        }
        set('points_reward', body.points_reward);
    }
    if (Object.hasOwn(body, 'workspace_id')) {
        const workspaceId = body.workspace_id === '' || body.workspace_id === null ? null : Number(body.workspace_id);
        if (workspaceId !== null && (!Number.isInteger(workspaceId) || workspaceId < 1)) {
            return res.status(400).json({ error: 'Choose a valid workspace.' });
        }
        if (workspaceId !== null && !await dbGet('SELECT id FROM project_workspaces WHERE id = ?', [workspaceId])) {
            return res.status(404).json({ error: 'Workspace not found.' });
        }
        set('workspace_id', workspaceId);
    }
    if (Object.hasOwn(body, 'priority')) {
        if (!['Low', 'Medium', 'High'].includes(body.priority)) return res.status(400).json({ error: 'Choose a valid task priority.' });
        set('priority', body.priority);
    }
    if (Object.hasOwn(body, 'deadline')) {
        const deadline = typeof body.deadline === 'string' && body.deadline ? body.deadline : null;
        if (body.deadline !== '' && body.deadline !== null && (typeof body.deadline !== 'string' || !isValidDateString(deadline))) return res.status(400).json({ error: 'Choose a valid deadline.' });
        set('deadline', deadline);
    }
    if (Object.hasOwn(body, 'link_url')) {
        const linkUrl = normalizeTaskLink(body.link_url);
        if (linkUrl === null || linkUrl.length > 2000) return res.status(400).json({ error: 'Enter a valid HTTP(S) task link.' });
        set('link_url', linkUrl);
    }
    if (Object.hasOwn(body, 'status') || Object.hasOwn(body, 'progress')) {
        const status = body.status || (Number(body.progress) >= 100 ? 'Complete' : Number(body.progress) > 0 ? 'Open' : 'Not started');
        if (!['Not started', 'Open', 'Complete'].includes(status)) return res.status(400).json({ error: 'Choose Not started, Open, or Complete.' });
        const progress = status === 'Complete' ? 100 : status === 'Open' ? 50 : 0;
        set('status', status);
        set('progress', progress);
    }
    if (Object.hasOwn(body, 'assignees')) {
        const guildIds = body.assignees;
        if (!Array.isArray(guildIds) || guildIds.length > 20 || guildIds.some((guildId) => typeof guildId !== 'string' || !guildId.trim() || guildId.length > 40) ||
            new Set(guildIds.map((guildId) => guildId.toUpperCase())).size !== guildIds.length) return res.status(400).json({ error: 'Choose up to 20 distinct member assignees.' });
        if (guildIds.length) {
            const validAssignees = await dbAll(
                `SELECT custom_id FROM members WHERE custom_id IS NOT NULL AND UPPER(custom_id) IN (${guildIds.map(() => 'UPPER(?)').join(',')})`,
                guildIds
            );
            if (validAssignees.length !== guildIds.length) return res.status(400).json({ error: 'One or more assignees are not current guild members.' });
        }
    }
    if (!changes.length && !Object.hasOwn(body, 'assignees')) return res.status(400).json({ error: 'Provide at least one task field to update.' });
    try {
        await withWriteTransaction(async () => {
            const task = await dbGet(
                `SELECT id FROM event_tasks WHERE id = ?${usesPostgres ? ' FOR UPDATE' : ''}`,
                [taskId]
            );
            if (!task) {
                const error = new Error('Task not found.');
                error.status = 404;
                throw error;
            }
            if (changes.length) {
                await dbRun(`UPDATE event_tasks SET ${changes.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...values, taskId]);
            }
            if (Object.hasOwn(body, 'assignees')) {
                await dbRun('DELETE FROM event_task_assignees WHERE task_id = ?', [taskId]);
                for (const guildId of body.assignees) {
                    await dbRun('INSERT INTO event_task_assignees (task_id, guild_id) VALUES (?, ?)', [taskId, guildId]);
                }
            }
        });
        return res.json({ success: true });
    } catch (error) {
        if (error.status === 404) return res.status(404).json({ error: error.message });
        console.error('Could not update event task:', error.message);
        return res.status(500).json({ error: 'Could not update event task.' });
    }
});

app.delete('/api/tasks/:id', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const taskId = Number(req.params.id);
    if (!Number.isInteger(taskId) || taskId < 1) return res.status(400).json({ error: 'Invalid task ID.' });
    try {
        const deleted = await withWriteTransaction(async () => {
            if (!await dbGet('SELECT id FROM event_tasks WHERE id = ?', [taskId])) return false;
            await dbRun('DELETE FROM event_task_attachments WHERE task_id = ?', [taskId]);
            await dbRun('DELETE FROM event_task_comments WHERE task_id = ?', [taskId]);
            await dbRun('DELETE FROM event_task_assignees WHERE task_id = ?', [taskId]);
            await dbRun('DELETE FROM event_task_subtasks WHERE task_id = ?', [taskId]);
            await dbRun('DELETE FROM event_tasks WHERE id = ?', [taskId]);
            return true;
        });
        if (!deleted) return res.status(404).json({ error: 'Task not found.' });
        return res.json({ success: true });
    } catch (error) {
        console.error('Could not delete event task:', error.message);
        return res.status(500).json({ error: 'Could not delete event task.' });
    }
});

app.post('/api/tasks/:id/subtasks', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const taskId = Number(req.params.id);
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!Number.isInteger(taskId) || taskId < 1 || !title || title.length > 160) return res.status(400).json({ error: 'Enter a task ID and subtask title (up to 160 characters).' });
    try {
        if (!await dbGet('SELECT id FROM event_tasks WHERE id = ?', [taskId])) return res.status(404).json({ error: 'Task not found.' });
        const result = usesPostgres
            ? await dbGet('INSERT INTO event_task_subtasks (task_id, title) VALUES (?, ?) RETURNING id', [taskId, title])
            : await dbRun('INSERT INTO event_task_subtasks (task_id, title) VALUES (?, ?)', [taskId, title]);
        return res.status(201).json({ success: true, id: result.id || result.lastID });
    } catch (error) {
        console.error('Could not add task subtask:', error.message);
        return res.status(500).json({ error: 'Could not add task subtask.' });
    }
});

app.patch('/api/tasks/:taskId/subtasks/:subtaskId', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const taskId = Number(req.params.taskId);
    const subtaskId = Number(req.params.subtaskId);
    const completed = req.body?.completed;
    if (!Number.isInteger(taskId) || taskId < 1 || !Number.isInteger(subtaskId) || subtaskId < 1 || typeof completed !== 'boolean') {
        return res.status(400).json({ error: 'Provide valid task and subtask IDs and a completion value.' });
    }
    try {
        const result = await dbRun('UPDATE event_task_subtasks SET completed = ? WHERE id = ? AND task_id = ?', [completed, subtaskId, taskId]);
        if (!result.changes) return res.status(404).json({ error: 'Subtask not found.' });
        return res.json({ success: true });
    } catch (error) {
        console.error('Could not update task subtask:', error.message);
        return res.status(500).json({ error: 'Could not update task subtask.' });
    }
});

app.delete('/api/tasks/:taskId/subtasks/:subtaskId', requireStaff, requireRoles(...taskStaffRoles), async (req, res) => {
    const taskId = Number(req.params.taskId);
    const subtaskId = Number(req.params.subtaskId);
    if (!Number.isInteger(taskId) || taskId < 1 || !Number.isInteger(subtaskId) || subtaskId < 1) return res.status(400).json({ error: 'Invalid task or subtask ID.' });
    try {
        const result = await dbRun('DELETE FROM event_task_subtasks WHERE id = ? AND task_id = ?', [subtaskId, taskId]);
        if (!result.changes) return res.status(404).json({ error: 'Subtask not found.' });
        return res.json({ success: true });
    } catch (error) {
        console.error('Could not delete task subtask:', error.message);
        return res.status(500).json({ error: 'Could not delete task subtask.' });
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
            await dbRun(
                'DELETE FROM event_task_assignees WHERE task_id IN (SELECT id FROM event_tasks WHERE event_id = ?)',
                [eventId]
            );
            await dbRun(
                'DELETE FROM event_task_subtasks WHERE task_id IN (SELECT id FROM event_tasks WHERE event_id = ?)',
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

app.get('/api/attendance', requireStaff, async (_req, res) => {
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

app.post('/api/attendance', requireStaff, async (req, res) => {
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
