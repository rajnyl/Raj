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
    return { status: response.status, body: await response.json() };
}

test('public members can read and check in; staff actions require an authenticated role', async () => {
    const publicRoster = await request('/api/members', undefined, 'GET');
    assert.equal(publicRoster.status, 200);
    assert.equal(publicRoster.body[0].nfc_uid, undefined);
    assert.equal((await request('/api/tasks?event_id=1', undefined, 'GET')).status, 401);
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
        body: 'See you there.'
    })).status, 201);
    assert.equal((await request('/api/announcements', undefined, 'GET')).body[0].author_role, 'executive');
    assert.equal((await request('/api/tasks', undefined, 'GET')).status, 400);
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
    assert.equal((await request(`/api/tasks/${task.body.id}`, {
        assignees: ['NOT-STAFF']
    }, 'PATCH')).status, 400);
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
    const adminEvent = await request('/api/events', {
        name: 'Admin-managed event',
        event_date: '2026-10-09',
        points: 10
    });
    assert.equal(adminEvent.status, 201);
    assert.equal((await request(`/api/events/${adminEvent.body.id}/close`, {})).status, 200);
    assert.equal((await request('/api/staff/password', {
        guild_id: 'TEST-002',
        password: 'test-officer-password'
    })).status, 200);
    await request('/api/auth/logout', {});
    const publicCheckin = await request('/api/attendance', {
        nfc_uid: '01020304',
        event_id: event.body.id
    });
    assert.equal(publicCheckin.status, 200);
    assert.equal((await request('/api/attendance', {
        nfc_uid: '01020304',
        event_id: event.body.id
    })).status, 409);
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
