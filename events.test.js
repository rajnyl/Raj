const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { after, before, test } = require('node:test');

const databasePath = path.join(os.tmpdir(), `ncgg-events-${process.pid}.sqlite`);
process.env.DB_PATH = databasePath;
process.env.BOOTSTRAP_ADMIN_GUILD_ID = 'NCGG-001';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'test-admin-password';
const readerBridgeToken = 'test-reader-bridge-token-for-events';
process.env.READER_BRIDGE_TOKEN = readerBridgeToken;

let server;
let baseUrl;
let cookie = '';
let closeDatabase;

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (closeDatabase) await closeDatabase();
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        try {
            fs.unlinkSync(file);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
});

before(async () => {
    await new Promise((resolve, reject) => {
        const seed = new sqlite3.Database(databasePath);
        seed.exec(`CREATE TABLE members (
            nfc_uid TEXT PRIMARY KEY, custom_id TEXT, name TEXT NOT NULL, role TEXT NOT NULL,
            points INTEGER NOT NULL DEFAULT 0, tier TEXT NOT NULL DEFAULT 'Regular'
        );
        CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, event_date TEXT NOT NULL,
            points INTEGER NOT NULL CHECK (points > 0), created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            closed_at DATETIME
        );
        CREATE TABLE event_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            committee TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
            priority TEXT NOT NULL CHECK (priority IN ('Low', 'Medium', 'High')),
            progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
            status TEXT NOT NULL DEFAULT 'Not started' CHECK (status IN ('Not started', 'Open', 'Complete')),
            link_url TEXT NOT NULL DEFAULT '', deadline TEXT, created_by TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE event_task_assignees (
            task_id INTEGER NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
            guild_id TEXT NOT NULL, PRIMARY KEY (task_id, guild_id)
        );
        CREATE TABLE merch_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT 'Accessories', price_cents INTEGER NOT NULL,
            cost_price_cents INTEGER NOT NULL DEFAULT 0, inventory INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1, low_stock_threshold INTEGER NOT NULL DEFAULT 5,
            image_type TEXT, image_filename TEXT, image_data TEXT, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE merch_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT NOT NULL UNIQUE,
            buyer_type TEXT NOT NULL CHECK (buyer_type IN ('member', 'walk-in')), buyer_id TEXT,
            buyer_name TEXT NOT NULL, subtotal_cents INTEGER NOT NULL, discount_percent INTEGER NOT NULL DEFAULT 0,
            discount_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL,
            payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'gcash', 'tab_utang')),
            payment_status TEXT NOT NULL CHECK (payment_status IN ('paid', 'partial', 'unpaid_tab')),
            amount_paid_cents INTEGER NOT NULL DEFAULT 0,
            fulfillment_status TEXT NOT NULL DEFAULT 'pending_pickup' CHECK (fulfillment_status IN ('pending_pickup', 'completed', 'cancelled')),
            due_date TEXT, award_points INTEGER NOT NULL DEFAULT 0, points_awarded INTEGER NOT NULL DEFAULT 0,
            cashier_id TEXT NOT NULL, cashier_name TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE merch_order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES merch_orders(id) ON DELETE CASCADE,
            item_id INTEGER REFERENCES merch_items(id) ON DELETE SET NULL, product_name TEXT NOT NULL,
            variant TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL,
            subtotal_cents INTEGER NOT NULL
        );
        CREATE TABLE merch_order_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES merch_orders(id) ON DELETE CASCADE,
            payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'gcash')),
            amount_cents INTEGER NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO members (nfc_uid, custom_id, name, role) VALUES
            ('AABBCCDD', 'TEST-EXEC', 'Test Executive', 'Executive'),
            ('01010101', 'NCGG-001', 'Guzman,Rajnyl,C', 'Member');`, (error) => {
            seed.close((closeError) => error || closeError ? reject(error || closeError) : resolve());
        });
    });
    const serverModule = require('../server');
    closeDatabase = serverModule.closeDatabase;
    const { startServer } = serverModule;
    server = await startServer(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await request('/api/auth/login', {
        guild_id: 'NCGG-001',
        password: 'test-admin-password'
    })).status, 200);
    assert.equal((await request('/api/staff/password', {
        guild_id: 'TEST-EXEC',
        password: 'test-executive-password'
    })).status, 200);
    await request('/api/auth/logout', {});
});

async function request(url, body, method = 'POST') {
    const response = await fetch(`${baseUrl}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const responseText = await response.text();
    let responseBody;
    try {
        responseBody = JSON.parse(responseText);
    } catch {
        throw new Error(`${method} ${url} returned non-JSON (${response.status}): ${responseText.slice(0, 120)}`);
    }
    return { status: response.status, body: responseBody };
}

test('public members can read the roster; attendance and staff actions require an authorized account', async () => {
    const publicRoster = await request('/api/members', undefined, 'GET');
    assert.equal(publicRoster.status, 200);
    assert.equal(publicRoster.body[0].nfc_uid, undefined);
    assert.equal((await request('/api/tasks?event_id=1', undefined, 'GET')).status, 401);
    assert.equal((await request('/api/project-workspaces', undefined, 'GET')).status, 401);
    assert.equal((await request('/api/members', {
        name: 'Unauthenticated Member',
        custom_id: 'TEST-000',
        role: 'Member',
        tier: 'Regular',
        nfc_uid: '00000000'
    })).status, 401);
    assert.equal((await request('/api/points/adjustments', undefined, 'GET')).status, 401);

    const login = await request('/api/auth/login', {
        guild_id: 'test-exec',
        password: 'test-executive-password'
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.staff.role, 'executive');
    const workspace = await request('/api/project-workspaces', { name: 'Events team' });
    assert.equal(workspace.status, 201);
    assert.equal((await request('/api/project-workspaces', { name: '' })).status, 400);
    const board = await request(`/api/project-workspaces/${workspace.body.id}/boards`, { name: 'Semester kickoff' });
    assert.equal(board.status, 201);
    assert.equal((await request(`/api/project-workspaces/${workspace.body.id}/boards`, undefined, 'GET')).body.length, 1);
    let projectBoard = await request(`/api/project-boards/${board.body.id}`, undefined, 'GET');
    assert.equal(projectBoard.status, 200);
    assert.equal(projectBoard.body.groups[0].name, 'To do');
    const firstGroup = projectBoard.body.groups[0];
    const group = await request(`/api/project-boards/${board.body.id}/groups`, { name: 'This month' });
    assert.equal(group.status, 201);
    const projectItem = await request(`/api/project-groups/${firstGroup.id}/items`, { title: 'Book the venue' });
    assert.equal(projectItem.status, 201);
    assert.equal((await request(`/api/project-groups/${firstGroup.id}/items`, { title: '' })).status, 400);
    assert.equal((await request(`/api/project-items/${projectItem.body.id}`, {
        status: 'Working on it',
        assignee: 'TEST-EXEC',
        due_date: '2026-12-10'
    }, 'PATCH')).status, 200);
    assert.equal((await request(`/api/project-items/${projectItem.body.id}`, { status: 'Unknown' }, 'PATCH')).status, 400);
    assert.equal((await request(`/api/project-items/${projectItem.body.id}`, { assignee: 'NOT-STAFF' }, 'PATCH')).status, 400);
    assert.equal((await request(`/api/project-items/${projectItem.body.id}`, { due_date: '2026-02-30' }, 'PATCH')).status, 400);
    projectBoard = await request(`/api/project-boards/${board.body.id}`, undefined, 'GET');
    assert.equal(projectBoard.body.groups.length, 2);
    assert.equal(projectBoard.body.groups[0].items[0].title, 'Book the venue');
    assert.equal(projectBoard.body.groups[0].items[0].status, 'Working on it');
    assert.equal(projectBoard.body.groups[0].items[0].assignee, 'TEST-EXEC');
    assert.equal(projectBoard.body.groups[0].items[0].due_date, '2026-12-10');
    const executiveRoster = await request('/api/members', undefined, 'GET');
    assert.equal(executiveRoster.body[0].nfc_uid, undefined);

    const member = await request('/api/members', {
        name: 'Test Member',
        custom_id: 'TEST-001',
        role: 'Member',
        tier: 'VIP',
        nfc_uid: '01020304'
    });
    assert.equal(member.status, 201);

    const officer = await request('/api/members', {
        name: 'Test Officer',
        custom_id: 'TEST-002',
        role: 'Officer',
        tier: 'Regular',
        nfc_uid: '05060708'
    });
    assert.equal(officer.status, 201);

    const listedMembers = await request('/api/members', undefined, 'GET');
    assert.equal(listedMembers.body.find((item) => item.custom_id === 'TEST-001').tier, 'VIP');
    assert.equal(listedMembers.body.find((item) => item.custom_id === 'TEST-002').role, 'Officer');

    const event = await request('/api/events', {
        name: 'Test Event',
        event_date: '2026-10-08',
        points: 10
    });
    assert.equal(event.status, 201);
    assert.equal((await request('/api/staff/password', {
        guild_id: 'TEST-002',
        password: 'test-officer-password'
    })).status, 403);
    assert.equal((await request('/api/announcements', {
        title: 'Meeting reminder',
        body: 'See you there.',
        media_type: 'image/png',
        media_filename: 'reminder.png',
        media_data: Buffer.from('test image').toString('base64')
    })).status, 201);
    const announcement = (await request('/api/announcements', undefined, 'GET')).body[0];
    assert.equal(announcement.author_role, 'executive');
    assert.equal(announcement.media_type, 'image/png');
    const mediaResponse = await fetch(`${baseUrl}/api/announcements/${announcement.id}/media`, {
        headers: { Cookie: cookie }
    });
    assert.equal(mediaResponse.headers.get('content-type'), 'image/png');
    assert.equal(await mediaResponse.text(), 'test image');
    assert.deepEqual((await request('/api/tasks', undefined, 'GET')).body, []);
    const task = await request('/api/tasks', {
        event_id: event.body.id,
        committee: 'Logistics',
        title: 'Prepare welcome table',
        priority: 'High',
        progress: 25,
        deadline: '2026-10-12',
        description: 'Arrange the sign-in materials.',
        link_url: 'https://example.com/checklist',
        status: 'Open',
        assignees: ['TEST-EXEC', 'TEST-002']
    });
    assert.equal(task.status, 201);
    const taskListUrl = `/api/tasks?event_id=${event.body.id}`;
    const standaloneTask = await request('/api/tasks', {
        committee: 'Guild-wide',
        title: 'Plan next semester',
        priority: 'Medium',
        assignees: ['TEST-EXEC']
    });
    assert.equal(standaloneTask.status, 201);
    const allTasks = await request('/api/tasks', undefined, 'GET');
    assert.equal(allTasks.status, 200);
    assert.equal(allTasks.body.find((item) => item.id === standaloneTask.body.id).event_id, null);
    const assignedTasks = await request('/api/profile/tasks', undefined, 'GET');
    assert.ok(assignedTasks.body.some((item) => item.id === standaloneTask.body.id));
    assert.ok(assignedTasks.body.some((item) => item.id === task.body.id));
    assert.equal((await request(taskListUrl, undefined, 'GET')).body[0].deadline, '2026-10-12');
    let taskDetails = (await request(taskListUrl, undefined, 'GET')).body[0];
    assert.equal(taskDetails.status, 'Open');
    assert.deepEqual(taskDetails.assignees, ['TEST-002', 'TEST-EXEC']);
    assert.equal((await request(`/api/tasks/${task.body.id}`, {
        status: 'Waiting',
        priority: 'Medium'
    }, 'PATCH')).status, 400);
    assert.equal((await request(`/api/tasks/${task.body.id}`, {
        progress: 50,
        priority: 'Medium',
        deadline: '2026-10-14'
    }, 'PATCH')).status, 200);
    assert.equal((await request(taskListUrl, undefined, 'GET')).body[0].deadline, '2026-10-14');
    assert.equal((await request(`/api/tasks/${task.body.id}`, {
        progress: 50,
        priority: 'Medium',
        deadline: '2026-02-30'
    }, 'PATCH')).status, 400);
    assert.equal((await request(`/api/tasks/${task.body.id}`, {
        progress: 50,
        priority: 'Medium',
        deadline: ''
    }, 'PATCH')).status, 200);
    assert.equal((await request(taskListUrl, undefined, 'GET')).body[0].deadline, null);
    await request(`/api/tasks/${task.body.id}`, {
        progress: 25,
        priority: 'High',
        deadline: '2026-10-12'
    }, 'PATCH');
    assert.equal((await request(`/api/tasks/${task.body.id}`, {
        title: 'Prepare the welcome table',
        committee: 'Guest Services',
        description: 'Arrange check-in supplies.',
        link_url: 'https://example.com/welcome',
        status: 'Complete',
        assignees: ['TEST-002']
    }, 'PATCH')).status, 200);
    taskDetails = (await request(taskListUrl, undefined, 'GET')).body[0];
    assert.equal(taskDetails.title, 'Prepare the welcome table');
    assert.equal(taskDetails.committee, 'Guest Services');
    assert.equal(taskDetails.description, 'Arrange check-in supplies.');
    assert.equal(taskDetails.status, 'Complete');
    assert.equal(taskDetails.progress, 100);
    assert.deepEqual(taskDetails.assignees, ['TEST-002']);
    assert.ok(!(await request('/api/profile/tasks', undefined, 'GET')).body.some((item) => item.id === task.body.id));
    assert.equal((await request(`/api/tasks/${task.body.id}`, {
        assignees: ['NOT-STAFF']
    }, 'PATCH')).status, 400);
    await request('/api/auth/logout', {});
    assert.equal((await request('/api/auth/login', {
        guild_id: 'NCGG-001',
        password: 'test-admin-password'
    })).status, 200);
    assert.equal((await request('/api/staff/password', {
        guild_id: 'TEST-002',
        password: 'test-officer-password'
    })).status, 200);
    await request('/api/auth/logout', {});
    assert.equal((await request('/api/auth/login', {
        guild_id: 'TEST-002',
        password: 'test-officer-password'
    })).status, 200);
    const officerTasks = await request('/api/profile/tasks', undefined, 'GET');
    assert.ok(officerTasks.body.some((item) => item.id === task.body.id && item.submitted === 0));
    const submissionUrl = `/api/profile/tasks/${task.body.id}/submission`;
    const submission = await request(submissionUrl, { submitted: true });
    assert.equal(submission.status, 200);
    assert.equal(submission.body.points_delta, 1);
    assert.equal(submission.body.points, 1);
    const repeatedSubmission = await request(submissionUrl, { submitted: true });
    assert.equal(repeatedSubmission.body.points_delta, 0);
    assert.equal((await request('/api/profile', undefined, 'GET')).body.profile.points, 1);
    assert.equal((await request(`/api/profile/tasks/${standaloneTask.body.id}/submission`, { submitted: true })).status, 403);
    const undoSubmission = await request(submissionUrl, { submitted: false });
    assert.equal(undoSubmission.body.points_delta, -1);
    assert.equal(undoSubmission.body.points, 0);
    const repeatedUndo = await request(submissionUrl, { submitted: false });
    assert.equal(repeatedUndo.body.points_delta, 0);
    assert.equal((await request('/api/profile/tasks', undefined, 'GET')).body.find((item) => item.id === task.body.id).submitted, 0);
    assert.equal((await request(submissionUrl, { submitted: 'yes' })).status, 400);
    await request('/api/auth/logout', {});
    assert.equal((await request('/api/auth/login', {
        guild_id: 'TEST-EXEC',
        password: 'test-executive-password'
    })).status, 200);
    const subtask = await request(`/api/tasks/${task.body.id}/subtasks`, { title: 'Set up sign-in materials' });
    assert.equal(subtask.status, 201);
    const secondSubtask = await request(`/api/tasks/${task.body.id}/subtasks`, { title: 'Print the attendee list' });
    assert.equal(secondSubtask.status, 201);
    assert.equal((await request(`/api/tasks/${task.body.id}/subtasks/${subtask.body.id}`, { completed: true }, 'PATCH')).status, 200);
    assert.equal((await request(`/api/tasks/${task.body.id}/subtasks/${secondSubtask.body.id}`, undefined, 'DELETE')).status, 200);
    assert.equal((await request(`/api/tasks/${task.body.id}/comments`, { body: 'I will handle this.' })).status, 201);
    assert.equal((await request(`/api/tasks/${task.body.id}/attachments`, {
        filename: 'brief.pdf',
        mime_type: 'application/pdf',
        content_base64: Buffer.from('%PDF-1.4 sample').toString('base64')
    })).status, 201);
    assert.equal((await request(`/api/tasks/${task.body.id}/attachments`, {
        filename: 'photo.jpg',
        mime_type: 'image/jpeg',
        content_base64: Buffer.from('sample image bytes').toString('base64')
    })).status, 201);
    const tasks = await request(taskListUrl, undefined, 'GET');
    assert.equal(tasks.body[0].comments[0].body, 'I will handle this.');
    assert.equal(tasks.body[0].attachments.length, 2);
    assert.equal(tasks.body[0].subtasks.length, 1);
    assert.equal(tasks.body[0].subtasks[0].completed, 1);
    assert.equal((await request(`/api/tasks/${task.body.id}`, undefined, 'DELETE')).status, 200);
    assert.deepEqual((await request(taskListUrl, undefined, 'GET')).body, []);

    await request('/api/auth/logout', {});
    const reactorId = '11111111-1111-4111-8111-111111111111';
    let publicAnnouncements = await request(`/api/announcements?reactor_id=${reactorId}`, undefined, 'GET');
    assert.equal(publicAnnouncements.body[0].title, 'Meeting reminder');
    assert.equal(publicAnnouncements.body[0].reaction_counts['👍'], 0);
    assert.equal((await request('/api/announcements/1/reactions', {
        reactor_id: reactorId,
        reaction: 'invalid'
    })).status, 400);
    assert.equal((await request('/api/announcements/1/reactions', {
        reactor_id: reactorId,
        reaction: '👍'
    })).status, 200);
    publicAnnouncements = await request(`/api/announcements?reactor_id=${reactorId}`, undefined, 'GET');
    assert.equal(publicAnnouncements.body[0].reaction_counts['👍'], 1);
    assert.equal(publicAnnouncements.body[0].user_reaction, '👍');
    assert.equal((await request('/api/announcements/1/reactions', {
        reactor_id: reactorId,
        reaction: '❤️'
    })).status, 200);
    publicAnnouncements = await request(`/api/announcements?reactor_id=${reactorId}`, undefined, 'GET');
    assert.equal(publicAnnouncements.body[0].reaction_counts['👍'], 0);
    assert.equal(publicAnnouncements.body[0].reaction_counts['❤️'], 1);
    assert.equal((await request('/api/announcements/1/reactions', {
        reactor_id: reactorId,
        reaction: '❤️'
    })).status, 200);
    publicAnnouncements = await request(`/api/announcements?reactor_id=${reactorId}`, undefined, 'GET');
    assert.equal(publicAnnouncements.body[0].reaction_counts['❤️'], 0);
    assert.equal(publicAnnouncements.body[0].user_reaction, '');
    assert.equal((await request('/api/announcements/1/reactions', {
        reactor_id: reactorId,
        reaction: '🤩'
    })).status, 200);
    publicAnnouncements = await request(`/api/announcements?reactor_id=${reactorId}`, undefined, 'GET');
    assert.equal(publicAnnouncements.body[0].reaction_counts['🤩'], 1);
    assert.equal(publicAnnouncements.body[0].user_reaction, '🤩');
    assert.equal((await request('/api/announcements/1/reactions', {
        reactor_id: reactorId,
        reaction: '🥳'
    })).status, 200);
    publicAnnouncements = await request(`/api/announcements?reactor_id=${reactorId}`, undefined, 'GET');
    assert.equal(publicAnnouncements.body[0].reaction_counts['🤩'], 0);
    assert.equal(publicAnnouncements.body[0].reaction_counts['🥳'], 1);
    assert.equal(publicAnnouncements.body[0].user_reaction, '🥳');
    assert.equal((await request('/api/announcements/1/reactions', {
        reactor_id: reactorId,
        reaction: 'not an emoji'
    })).status, 400);
    assert.equal((await request(`/api/tasks?event_id=${event.body.id}`, undefined, 'GET')).status, 401);
    const adminLogin = await request('/api/auth/login', {
        guild_id: 'NCGG-001',
        password: 'test-admin-password'
    });
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLogin.body.staff.role, 'admin');
    const adminRoster = await request('/api/members', undefined, 'GET');
    assert.equal(adminRoster.body.find((item) => item.custom_id === 'TEST-001').nfc_uid, '01020304');
    const adminPointAdjustment = await request('/api/points/adjust', {
        guild_id: 'TEST-001',
        amount: 5,
        direction: 'add',
        reason: 'Admin role inherits executive point adjustment access.'
    });
    assert.equal(adminPointAdjustment.status, 200);
    assert.equal(adminPointAdjustment.body.newPoints, 5);
    assert.equal((await request('/api/staff/password', {
        guild_id: 'TEST-001',
        password: 'test-member-password'
    })).status, 200);
    const memberQuest = await request('/api/tasks', {
        workspace_id: workspace.body.id,
        committee: 'Guild-wide',
        title: 'Welcome quest',
        priority: 'Medium',
        points_reward: 3,
        assignees: ['TEST-001']
    });
    assert.equal(memberQuest.status, 201);
    const linkedTask = (await request('/api/tasks', undefined, 'GET')).body.find((item) => item.id === memberQuest.body.id);
    assert.equal(linkedTask.workspace_id, workspace.body.id);
    assert.equal(linkedTask.workspace_name, 'Events team');
    await request('/api/auth/logout', {});
    assert.equal((await request(`/api/events/${event.body.id}/attendance-report`, undefined, 'GET')).status, 401);
    assert.equal((await request('/api/auth/login', {
        guild_id: 'TEST-001',
        password: 'test-member-password'
    })).status, 200);
    const memberQuests = await request('/api/profile/tasks', undefined, 'GET');
    assert.equal(memberQuests.status, 200);
    assert.ok(memberQuests.body.some((item) => item.id === memberQuest.body.id && item.points_reward === 3));
    const memberSubmission = await request(`/api/profile/tasks/${memberQuest.body.id}/submission`, { submitted: true });
    assert.equal(memberSubmission.status, 200);
    assert.equal(memberSubmission.body.points_delta, 3);
    assert.equal(memberSubmission.body.points, 8);
    assert.equal((await request('/api/profile', undefined, 'GET')).body.profile.points, 8);
    const memberUndo = await request(`/api/profile/tasks/${memberQuest.body.id}/submission`, { submitted: false });
    assert.equal(memberUndo.body.points_delta, -3);
    assert.equal(memberUndo.body.points, 5);
    await request('/api/auth/logout', {});
    assert.equal((await request('/api/auth/login', {
        guild_id: 'NCGG-001',
        password: 'test-admin-password'
    })).status, 200);
    assert.equal((await request('/api/merch', {
        name: 'Guild shirt',
        description: 'Official guild shirt',
        price_cents: 12500,
        inventory: 20,
        image_type: 'image/png',
        image_filename: 'shirt.png',
        image_data: Buffer.from('shirt image').toString('base64')
    })).status, 201);
    const merchItems = await request('/api/merch', undefined, 'GET');
    assert.equal(merchItems.body[0].price_cents, 12500);
    const merchItem = merchItems.body[0];
    assert.equal(merchItem.image_type, 'image/png');
    assert.equal(merchItem.image_data, undefined);
    const merchImage = await fetch(`${baseUrl}/api/merch/${merchItem.id}/image`, {
        headers: { Cookie: cookie }
    });
    assert.equal(merchImage.headers.get('content-type'), 'image/png');
    assert.equal(await merchImage.text(), 'shirt image');
    assert.equal((await request(`/api/merch/${merchItem.id}`, {
        name: 'Updated Guild shirt',
        description: 'Updated description',
        price_cents: 13000,
        inventory: 15,
        image_type: 'image/webp',
        image_filename: 'shirt.webp',
        image_data: Buffer.from('new shirt image').toString('base64')
    }, 'PATCH')).status, 200);
    const updatedMerchImage = await fetch(`${baseUrl}/api/merch/${merchItem.id}/image`, {
        headers: { Cookie: cookie }
    });
    assert.equal(updatedMerchImage.headers.get('content-type'), 'image/webp');
    assert.equal(await updatedMerchImage.text(), 'new shirt image');
    assert.equal((await request(`/api/merch/${merchItem.id}`, {
        name: 'Updated Guild shirt',
        description: 'Updated description',
        price_cents: 13000,
        inventory: 15,
        remove_image: true
    }, 'PATCH')).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/merch/${merchItem.id}/image`)).status, 404);
    const adminEvent = await request('/api/events', {
        name: 'Admin-managed event',
        event_date: '2026-10-09',
        points: 10
    });
    assert.equal(adminEvent.status, 201);
    assert.equal((await request(`/api/events/${adminEvent.body.id}/close`, {})).status, 200);
    assert.equal((await request('/api/attendance', {
        nfc_uid: '01020304',
        event_id: event.body.id
    })).status, 200);
    assert.equal((await request('/api/attendance', {
        nfc_uid: '05060708',
        event_id: event.body.id
    })).status, 200);
    const attendanceReport = await request(`/api/events/${event.body.id}/attendance-report`, undefined, 'GET');
    assert.equal(attendanceReport.status, 200);
    assert.equal(attendanceReport.body.attendee_count, 2);
    assert.equal(attendanceReport.body.attendees[0].member_name, 'Test Member');
    assert.equal(attendanceReport.body.attendees[0].custom_id, 'TEST-001');
    assert.equal(attendanceReport.body.attendees[1].member_name, 'Test Officer');
    const emptyAttendanceReport = await request(`/api/events/${adminEvent.body.id}/attendance-report`, undefined, 'GET');
    assert.equal(emptyAttendanceReport.body.attendee_count, 0);
    assert.equal((await request('/api/events/not-an-id/attendance-report', undefined, 'GET')).status, 400);
    assert.equal((await request('/api/staff/password', {
        guild_id: 'TEST-002',
        password: 'test-officer-password'
    })).status, 200);
    await request('/api/auth/logout', {});
    assert.equal((await request('/api/attendance', {
        nfc_uid: '01020304',
        event_id: event.body.id
    })).status, 401);
    assert.equal((await request('/api/attendance', {
        nfc_uid: '01020304',
        event_id: event.body.id
    })).status, 401);
    const memberLogin = await request('/api/auth/login', {
        guild_id: 'TEST-001',
        password: 'test-member-password'
    });
    assert.equal(memberLogin.status, 200);
    assert.equal(memberLogin.body.staff.role, 'member');
    const memberProfile = await request('/api/profile', undefined, 'GET');
    assert.equal(memberProfile.status, 200);
    assert.equal(memberProfile.body.profile.custom_id, 'TEST-001');
    assert.equal(memberProfile.body.profile.points, 15);
    assert.equal(memberProfile.body.attendance.length, 1);
    assert.equal((await request('/api/tasks', undefined, 'GET')).status, 403);
    assert.equal((await request('/api/merch', {
        name: 'Unauthorized item',
        description: '',
        price_cents: 1,
        inventory: 1
    })).status, 403);
    assert.equal((await request(`/api/merch/${merchItem.id}`, {
        name: 'Unauthorized edit',
        description: '',
        price_cents: 1,
        inventory: 1
    }, 'PATCH')).status, 403);
    assert.equal((await request('/api/attendance', undefined, 'GET')).status, 403);
    assert.equal((await request(`/api/events/${event.body.id}/attendance-report`, undefined, 'GET')).status, 403);
    assert.equal((await request('/api/attendance', {
        nfc_uid: '01020304',
        event_id: event.body.id
    })).status, 403);
    await request('/api/auth/logout', {});
    const officerLogin = await request('/api/auth/login', {
        guild_id: 'TEST-002',
        password: 'test-officer-password'
    });
    assert.equal(officerLogin.status, 200);
    const officerRoster = await request('/api/members', undefined, 'GET');
    assert.equal(officerRoster.body.find((item) => item.custom_id === 'TEST-001').nfc_uid, undefined);
    assert.equal((await request('/api/staff/password', {
        guild_id: 'TEST-002',
        password: 'new-officer-password'
    })).status, 403);
    assert.equal((await request(`/api/tasks?event_id=${event.body.id}`, undefined, 'GET')).status, 200);
    assert.equal((await request(`/api/events/${event.body.id}/close`, { actor_role: 'executive' })).status, 403);
    await request('/api/auth/logout', {});
    await request('/api/auth/login', {
        guild_id: 'TEST-EXEC',
        password: 'test-executive-password'
    });
    assert.equal((await request(`/api/events/${event.body.id}/close`, { actor_role: 'officer' })).status, 200);
    assert.equal((await request('/api/attendance', {
        nfc_uid: '01020304',
        event_id: event.body.id
    })).status, 409);

    const closedEvents = await request('/api/events', undefined, 'GET');
    assert.ok(closedEvents.body.find((item) => item.id === event.body.id).closed_at);
});

test('administrator can replace cards for any account while retaining account history and access', async () => {
    await request('/api/auth/login', {
        guild_id: 'TEST-EXEC',
        password: 'test-executive-password'
    });
    assert.equal((await request('/api/members/TEST-001/nfc-card', { nfc_uid: 'DEADBEEF' }, 'PATCH')).status, 403);

    await request('/api/auth/login', {
        guild_id: 'NCGG-001',
        password: 'test-admin-password'
    });
    const historicalEvent = (await request('/api/events', undefined, 'GET')).body
        .find((event) => event.name === 'Test Event');
    assert.ok(historicalEvent);
    assert.equal((await request('/api/members/TEST-001/nfc-card', { nfc_uid: '05060708' }, 'PATCH')).status, 409);
    assert.equal((await request('/api/members/TEST-001/nfc-card', { nfc_uid: '' }, 'PATCH')).status, 400);
    assert.equal((await request('/api/members/UNKNOWN/nfc-card', { nfc_uid: 'DEADBEEF' }, 'PATCH')).status, 404);
    assert.equal((await request('/api/members/TEST-001/nfc-card', { nfc_uid: 'DE:AD-BE:EF' }, 'PATCH')).status, 200);

    let adminRoster = await request('/api/members', undefined, 'GET');
    assert.equal(adminRoster.body.find((member) => member.custom_id === 'TEST-001').nfc_uid, 'DEADBEEF');
    assert.equal(adminRoster.body.find((member) => member.custom_id === 'TEST-001').points, 15);
    const historicalReport = await request(`/api/events/${historicalEvent.id}/attendance-report`, undefined, 'GET');
    assert.equal(historicalReport.status, 200);
    assert.equal(historicalReport.body.attendee_count, 2);
    assert.ok(historicalReport.body.attendees.some((attendee) => attendee.custom_id === 'TEST-001'));
    await request('/api/auth/login', { guild_id: 'TEST-001', password: 'test-member-password' });
    const memberProfile = await request('/api/profile', undefined, 'GET');
    assert.equal(memberProfile.status, 200);
    assert.equal(memberProfile.body.attendance.length, 1);
    assert.equal(memberProfile.body.profile.points, 15);

    await request('/api/auth/login', { guild_id: 'NCGG-001', password: 'test-admin-password' });
    const replacementCardEvent = await request('/api/events', {
        name: 'Replacement card test',
        event_date: '2026-11-10',
        points: 10
    });
    assert.equal(replacementCardEvent.status, 201);
    assert.equal((await request('/api/attendance', {
        nfc_uid: '01020304',
        event_id: replacementCardEvent.body.id
    })).status, 404);
    assert.equal((await request('/api/attendance', {
        nfc_uid: 'DEADBEEF',
        event_id: replacementCardEvent.body.id
    })).status, 200);
    assert.equal((await request('/api/members/TEST-002/nfc-card', { nfc_uid: '11223344' }, 'PATCH')).status, 200);
    await request('/api/auth/login', { guild_id: 'TEST-002', password: 'test-officer-password' });
    assert.equal((await request('/api/auth/me', undefined, 'GET')).body.staff.role, 'officer');

    await request('/api/auth/login', { guild_id: 'NCGG-001', password: 'test-admin-password' });
    assert.equal((await request('/api/members/NCGG-001/nfc-card', { nfc_uid: 'ABCDEF01' }, 'PATCH')).status, 200);
    assert.equal((await request('/api/auth/me', undefined, 'GET')).status, 200);
    adminRoster = await request('/api/members', undefined, 'GET');
    assert.equal(adminRoster.body.find((member) => member.custom_id === 'NCGG-001').nfc_uid, 'ABCDEF01');
});

test('POS checkout applies role-restricted tabs, payments, stock changes, points, and cancellation', async () => {
    await request('/api/auth/login', { guild_id: 'NCGG-001', password: 'test-admin-password' });
    const product = await request('/api/merch', {
        name: 'POS jersey',
        description: 'Variant stock test',
        category: 'Apparel',
        price_cents: 10000,
        cost_price_cents: 5000,
        low_stock_threshold: 1,
        variants: [{ variant: 'M', inventory: 2 }, { variant: 'L', inventory: 2 }]
    });
    assert.equal(product.status, 201);
    const addedVariant = await request(`/api/merch/${product.body.id}`, {
        name: 'POS jersey',
        description: 'Variant stock test',
        category: 'Apparel',
        price_cents: 10000,
        cost_price_cents: 5000,
        low_stock_threshold: 1,
        variants: [{ variant: 'M', inventory: 2 }, { variant: 'L', inventory: 2 }, { variant: 'XL', inventory: 3 }]
    }, 'PATCH');
    assert.equal(addedVariant.status, 200);
    const stickerProduct = await request('/api/merch', {
        name: 'POS sticker pack',
        description: 'Category and cost snapshot test',
        category: 'Stickers',
        price_cents: 1000,
        cost_price_cents: 250,
        low_stock_threshold: 1,
        variants: [{ variant: 'Standard', inventory: 10 }]
    });
    assert.equal(stickerProduct.status, 201);

    assert.equal((await request('/api/pos/orders', {})).status, 403);
    const initialPosAccess = await request('/api/admin/pos-access', undefined, 'GET');
    assert.equal(initialPosAccess.status, 200);
    assert.equal(initialPosAccess.body.find((officer) => officer.custom_id === 'TEST-002').pos_access, false);
    assert.equal((await request('/api/admin/pos-access/TEST-001', { enabled: true }, 'PATCH')).status, 409);
    assert.equal((await request('/api/admin/pos-access/TEST-002', { enabled: 'true' }, 'PATCH')).status, 400);

    await request('/api/auth/login', { guild_id: 'TEST-002', password: 'test-officer-password' });
    assert.equal((await request('/api/auth/me', undefined, 'GET')).body.staff.can_pos_transact, false);
    assert.equal((await request('/api/pos/orders', {})).status, 403);
    await request('/api/auth/login', { guild_id: 'NCGG-001', password: 'test-admin-password' });
    assert.equal((await request('/api/admin/pos-access/TEST-002', { enabled: true }, 'PATCH')).status, 200);

    await request('/api/auth/login', { guild_id: 'TEST-EXEC', password: 'test-executive-password' });
    assert.equal((await request('/api/auth/me', undefined, 'GET')).body.staff.can_pos_transact, true);
    const tabOrder = await request('/api/pos/orders', {
        buyer_type: 'member',
        buyer_id: 'TEST-EXEC',
        items: [{ product_id: product.body.id, variant: 'M', quantity: 2 }],
        payment_method: 'tab_utang',
        due_date: '2026-12-01'
    });
    assert.equal(tabOrder.status, 201);
    assert.match(tabOrder.body.order_code, /^GG\d{3,6}$/);
    assert.equal(tabOrder.body.cashier_id, 'TEST-EXEC');
    assert.equal(tabOrder.body.cashier_name, 'Test Executive');
    assert.equal(tabOrder.body.items[0].product_name, 'POS jersey');
    assert.equal(tabOrder.body.payment_status, 'unpaid_tab');
    let listedProducts = await request('/api/merch', undefined, 'GET');
    assert.equal(listedProducts.body.find((item) => item.id === product.body.id).variants.find((variant) => variant.variant === 'M').inventory, 0);

    const unauthorizedTab = await request('/api/pos/orders', {
        buyer_type: 'member',
        buyer_id: 'TEST-001',
        items: [{ product_id: product.body.id, variant: 'L', quantity: 1 }],
        payment_method: 'tab_utang',
        due_date: '2026-12-01'
    });
    assert.equal(unauthorizedTab.status, 403);
    listedProducts = await request('/api/merch', undefined, 'GET');
    assert.equal(listedProducts.body.find((item) => item.id === product.body.id).variants.find((variant) => variant.variant === 'L').inventory, 2);

    const orders = await request('/api/pos/orders', undefined, 'GET');
    const purchaseIds = orders.body.map((order) => order.order_code);
    assert.equal(new Set(purchaseIds).size, purchaseIds.length);
    const persistedTab = orders.body.find((order) => order.order_code === tabOrder.body.order_code);
    assert.ok(persistedTab);
    assert.equal(persistedTab.cashier_id, 'TEST-EXEC');
    assert.equal(persistedTab.cashier_name, 'Test Executive');
    await request('/api/auth/login', { guild_id: 'NCGG-001', password: 'test-admin-password' });
    assert.equal((await request(`/api/pos/orders/${persistedTab.id}/payments`, {})).status, 403);
    assert.equal((await request(`/api/pos/orders/${persistedTab.id}/void`, {})).status, 403);
    assert.equal((await request(`/api/pos/orders/${persistedTab.id}/fulfillment`, { status: 'completed' }, 'PATCH')).status, 403);
    await request('/api/auth/login', { guild_id: 'TEST-EXEC', password: 'test-executive-password' });
    const missingPaymentReference = await request(`/api/pos/orders/${persistedTab.id}/payments`, {
        amount_cents: 20000,
        payment_method: 'gcash'
    });
    assert.equal(missingPaymentReference.status, 400);
    const payment = await request(`/api/pos/orders/${persistedTab.id}/payments`, {
        amount_cents: 20000,
        payment_method: 'gcash',
        reference_number: 'GCASH-TEST-REF-001'
    });
    assert.equal(payment.status, 200);
    assert.equal(payment.body.payment_status, 'paid');
    const paidTab = (await request('/api/pos/orders', undefined, 'GET')).body.find((order) => order.id === persistedTab.id);
    assert.equal(paidTab.payments[0].reference_number, 'GCASH-TEST-REF-001');
    assert.equal((await request(`/api/pos/orders/${persistedTab.id}/fulfillment`, { status: 'completed' }, 'PATCH')).status, 200);
    assert.equal((await request(`/api/pos/orders/${persistedTab.id}/void`, {
        reason: 'Attempt to void after pickup',
        refund_method: 'cash'
    })).status, 409);

    const memberBefore = (await request('/api/members', undefined, 'GET')).body.find((member) => member.custom_id === 'TEST-001').points;
    const paidOrder = await request('/api/pos/orders', {
        buyer_type: 'member',
        buyer_id: 'TEST-001',
        items: [{ product_id: product.body.id, variant: 'L', quantity: 1 }],
        payment_method: 'cash',
        award_points: true
    });
    assert.equal(paidOrder.status, 201);
    assert.match(paidOrder.body.order_code, /^GG\d{3,6}$/);
    assert.equal(paidOrder.body.points_awarded, 1);
    const memberAfter = (await request('/api/members', undefined, 'GET')).body.find((member) => member.custom_id === 'TEST-001').points;
    assert.equal(memberAfter, memberBefore + 1);
    const voidWithoutRefund = await request(`/api/pos/orders/${paidOrder.body.id}/void`, {
        reason: 'Duplicate purchase'
    });
    assert.equal(voidWithoutRefund.status, 400);
    const voidWithoutRefundReference = await request(`/api/pos/orders/${paidOrder.body.id}/void`, {
        reason: 'Duplicate purchase',
        refund_method: 'qr'
    });
    assert.equal(voidWithoutRefundReference.status, 400);
    const voidPaidOrder = await request(`/api/pos/orders/${paidOrder.body.id}/void`, {
        reason: 'Duplicate purchase',
        refund_method: 'qr',
        refund_reference_number: 'REFUND-QR-TEST-001'
    });
    assert.equal(voidPaidOrder.status, 200);
    assert.equal(voidPaidOrder.body.refund_amount_cents, 10000);
    const voidedOrder = (await request('/api/pos/orders', undefined, 'GET')).body.find((order) => order.id === paidOrder.body.id);
    assert.equal(voidedOrder.voided_by_id, 'TEST-EXEC');
    assert.equal(voidedOrder.void_reason, 'Duplicate purchase');
    assert.equal(voidedOrder.refund_reference_number, 'REFUND-QR-TEST-001');
    const memberAfterVoid = (await request('/api/members', undefined, 'GET')).body.find((member) => member.custom_id === 'TEST-001').points;
    assert.equal(memberAfterVoid, memberBefore);

    const cancellableTab = await request('/api/pos/orders', {
        buyer_type: 'member',
        buyer_id: 'TEST-EXEC',
        items: [{ product_id: product.body.id, variant: 'L', quantity: 1 }],
        payment_method: 'tab_utang',
        due_date: '2026-12-01'
    });
    assert.equal(cancellableTab.status, 201);
    const currentOrders = await request('/api/pos/orders', undefined, 'GET');
    const orderToCancel = currentOrders.body.find((order) => order.order_code === cancellableTab.body.order_code);
    assert.equal((await request(`/api/pos/orders/${orderToCancel.id}/fulfillment`, { status: 'cancelled' }, 'PATCH')).status, 200);
    listedProducts = await request('/api/merch', undefined, 'GET');
    assert.equal(listedProducts.body.find((item) => item.id === product.body.id).variants.find((variant) => variant.variant === 'L').inventory, 2);

    await request('/api/auth/login', { guild_id: 'TEST-002', password: 'test-officer-password' });
    assert.equal((await request('/api/auth/me', undefined, 'GET')).body.staff.can_pos_transact, true);
    const walkInOrderPayload = {
        buyer_type: 'walk-in',
        buyer_name: 'Guest Buyer',
        items: [
            { product_id: product.body.id, variant: 'L', quantity: 1 },
            { product_id: stickerProduct.body.id, variant: 'Standard', quantity: 2 }
        ],
        discount_percent: 10,
        payment_method: 'qr'
    };
    const missingCheckoutReference = await request('/api/pos/orders', walkInOrderPayload);
    assert.equal(missingCheckoutReference.status, 400);
    const walkInOrder = await request('/api/pos/orders', {
        ...walkInOrderPayload,
        reference_number: 'QR-TEST-REF-001'
    });
    assert.equal(walkInOrder.status, 201);
    assert.match(walkInOrder.body.order_code, /^WP\d{3,6}$/);
    assert.equal(walkInOrder.body.cashier_id, 'TEST-002');
    assert.equal(walkInOrder.body.cashier_name, 'Test Officer');
    assert.equal(walkInOrder.body.discount_cents, 1200);
    assert.equal(walkInOrder.body.payments[0].reference_number, 'QR-TEST-REF-001');

    await request('/api/auth/login', { guild_id: 'NCGG-001', password: 'test-admin-password' });
    assert.equal((await request('/api/admin/pos-access/TEST-002', { enabled: false }, 'PATCH')).status, 200);
    await request('/api/auth/login', { guild_id: 'TEST-002', password: 'test-officer-password' });
    assert.equal((await request('/api/auth/me', undefined, 'GET')).body.staff.can_pos_transact, false);
    assert.equal((await request(`/api/pos/orders/${walkInOrder.body.id}/fulfillment`, {
        status: 'completed'
    }, 'PATCH')).status, 403);
    assert.equal((await request('/api/admin/pos-access', undefined, 'GET')).status, 403);

    const analytics = await request('/api/pos/analytics', undefined, 'GET');
    assert.equal(analytics.status, 200);
    assert.equal(analytics.body.revenue_cents, 30800);
    assert.equal(analytics.body.outstanding_cents, 0);
    assert.equal((await request('/api/pos/orders', undefined, 'GET')).status, 200);
    assert.equal((await request('/api/pos/admin-summary', undefined, 'GET')).status, 403);
    await request('/api/auth/login', { guild_id: 'NCGG-001', password: 'test-admin-password' });
    const summary = await request('/api/pos/admin-summary', undefined, 'GET');
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.body.categories, [
        {
            category: 'Apparel',
            quantity_sold: 3,
            gross_cents: 30000,
            discount_cents: 1000,
            net_sales_cents: 29000,
            production_cost_cents: 15000,
            profit_cents: 14000
        },
        {
            category: 'Stickers',
            quantity_sold: 2,
            gross_cents: 2000,
            discount_cents: 200,
            net_sales_cents: 1800,
            production_cost_cents: 500,
            profit_cents: 1300
        }
    ]);
    assert.equal(summary.body.totals.net_sales_cents, 30800);
    assert.equal(summary.body.totals.production_cost_cents, 15500);
    assert.equal(summary.body.totals.profit_cents, 15300);
    assert.equal((await request(`/api/merch/${stickerProduct.body.id}`, {
        name: 'POS sticker pack',
        description: 'Category and cost snapshot test',
        category: 'Accessories',
        price_cents: 1000,
        cost_price_cents: 1000,
        low_stock_threshold: 1,
        variants: [{ variant: 'Standard', inventory: 8 }]
    }, 'PATCH')).status, 200);
    const unchangedSummary = await request('/api/pos/admin-summary', undefined, 'GET');
    assert.equal(unchangedSummary.body.categories[1].category, 'Stickers');
    assert.equal(unchangedSummary.body.categories[1].production_cost_cents, 500);
});

test('local reader bridge accepts heartbeats and scans and validates diagnostics', async () => {
    const requestBridge = async (endpoint, payload, token = readerBridgeToken) => {
        const response = await fetch(`${baseUrl}/api/reader/${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });
        return { status: response.status, body: await response.json() };
    };

    assert.equal((await requestBridge('heartbeat', { reader: 'Test reader' }, 'invalid-token')).status, 200);
    assert.equal((await requestBridge('scan', { nfc_uid: 'AA:BB:CC:DD' }, 'invalid-token')).status, 200);
    assert.equal((await requestBridge('error', { message: 'Card read failed.' }, 'invalid-token')).status, 200);
    assert.equal((await requestBridge('error', { message: 'x'.repeat(501) })).status, 400);
});
