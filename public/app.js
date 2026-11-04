const loginOverlay = document.getElementById('login-overlay');
const nfcForm = document.getElementById('nfc-form');
const nfcInput = document.getElementById('nfc-input');
const activeEventSelect = document.getElementById('active-event-select');
const feedback = document.getElementById('scan-feedback');
const GUILD_TIME_ZONE = 'Asia/Manila';
const ANNOUNCEMENT_REACTIONS = ['👍', '❤️', '🎮', '🔥', '🎉', '👏', '🙌', '😂', '😍', '🤩', '😮', '😢', '🙏', '💯', '🚀', '✅', '👀', '💡', '🏆', '💪'];
const emojiReactionSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function isEmojiReaction(value) {
    return value.length <= 32 && [...emojiReactionSegmenter.segment(value)].length === 1 &&
        /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u.test(value);
}

function getGuildDateParts(date = new Date()) {
    return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: GUILD_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function getGuildDateString(date = new Date()) {
    const { year, month, day } = getGuildDateParts(date);
    return `${year}-${month}-${day}`;
}

function getGuildCalendarStart(date = new Date()) {
    const { year, month } = getGuildDateParts(date);
    return new Date(Number(year), Number(month) - 1, 1);
}

function formatGuildDate(dateString) {
    const [year, month, day] = dateString.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 12)).toLocaleDateString(undefined, {
        timeZone: GUILD_TIME_ZONE,
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });
}

let members = [];
let events = [];
let attendance = [];
let profileAttendance = [];
let profileTasks = [];
let profileTaskPollTimer = null;
let merchItems = [];
const merchCart = new Map();
const formatMerchPrice = (priceCents) => new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'PHP'
}).format(Number(priceCents) / 100);
let pointAdjustments = [];
let announcements = [];
let eventTasks = [];
let projectWorkspaces = [];
let projectBoards = [];
let projectBoard = null;
let taskCalendarDate = getGuildCalendarStart();
let activityCalendarDate = getGuildCalendarStart();
let activityCalendarSelectedDate = getGuildDateString();
let activityCalendarView = 'month';
let taskView = 'board';
let currentView = 'member';
let authenticatedStaff = null;
const pendingAnnouncementReactions = new Set();
const openAnnouncementReactionPickers = new Set();
let scanTimer = null;
let scanInProgress = false;
let syncInProgress = false;
let databaseMode = 'cloud';
let cloudReachable = true;
let offlineCacheWarningShown = false;

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch((error) => {
        console.error('Could not enable offline dashboard support:', error);
    });
}

async function api(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || 'The request could not be completed.');
        error.status = response.status;
        throw error;
    }
    return data;
}

function isNetworkError(error) {
    const offline = !navigator.onLine || error instanceof TypeError;
    if (offline) cloudReachable = false;
    return offline;
}

function normalizeUid(uid) {
    return String(uid || '').trim().replace(/^0x/i, '').replace(/[\s:-]/g, '').toUpperCase();
}

function getAnnouncementReactorId() {
    const key = 'ncgg-announcement-reactor';
    const saved = window.localStorage.getItem(key);
    if (saved && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved)) {
        return saved.toLowerCase();
    }
    if (!window.crypto?.randomUUID) throw new Error('This browser cannot create a reaction identity. Update your browser and try again.');
    const id = window.crypto.randomUUID();
    window.localStorage.setItem(key, id);
    return id;
}

async function loadAnnouncements() {
    const reactorId = getAnnouncementReactorId();
    return api(`/api/announcements?reactor_id=${encodeURIComponent(reactorId)}`);
}

async function updateNetworkStatus() {
    const queued = await window.offlineStore.listCheckins();
    const badge = document.getElementById('database-status');
    if (!navigator.onLine || !cloudReachable) {
        const pending = queued.filter((item) => item.status === 'pending').length;
        const failed = queued.filter((item) => item.status === 'failed').length;
        badge.textContent = `Offline · ${pending} check-ins waiting${failed ? ` · ${failed} need review` : ''}`;
    } else {
        badge.textContent = databaseMode === 'cloud' ? 'Shared cloud database' : 'Local database';
        const failed = queued.filter((item) => item.status === 'failed').length;
        if (failed) badge.textContent += ` · ${failed} need review`;
        else if (queued.some((item) => item.status === 'pending')) badge.textContent += ' · syncing check-ins';
    }
}

async function renderAttendanceWithQueuedCheckins() {
    const queue = await window.offlineStore.listCheckins();
    const pendingLogs = queue.map((item) => ({
        id: `offline-${item.id}`,
        timestamp: item.createdAt,
        event_name: item.eventName,
        points_awarded: item.points,
        member_name: item.memberName,
        custom_id: item.customId,
        offlineStatus: item.status === 'failed' ? `Sync failed: ${item.error}` : 'Waiting to sync'
    }));
    attendance = [...pendingLogs, ...attendance.filter((item) => !String(item.id).startsWith('offline-'))];
    renderAttendance();
    await updateNetworkStatus();
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' toast-error' : ''}`;
    toast.textContent = message;
    document.getElementById('toast-container').appendChild(toast);
    window.setTimeout(() => toast.remove(), 3600);
}

async function refreshData(syncQueue = true) {
    try {
        const [nextMembers, nextEvents, nextAttendance, nextAnnouncements] = await Promise.all([
            api('/api/members'), api('/api/events'),
            ['officer', 'executive', 'admin'].includes(currentView) ? api('/api/attendance') : Promise.resolve([]),
            loadAnnouncements()
        ]);
        cloudReachable = true;
        members = nextMembers;
        events = nextEvents;
        attendance = nextAttendance;
        announcements = nextAnnouncements;
        pointAdjustments = ['officer', 'executive', 'admin'].includes(currentView) ? await api('/api/points/adjustments') : [];
        const snapshots = { events, attendance };
        if (currentView === 'admin' && members.every((member) => typeof member.nfc_uid === 'string')) {
            snapshots.members = members;
        } else {
            await window.offlineStore.removeSnapshot('members');
        }
        await window.offlineStore.saveSnapshots(snapshots);
        renderDashboard();
        renderMembers();
        renderEvents();
        renderEventOptions();
        renderPointsMemberOptions();
        renderPointHistory();
        renderStaffPasswordOptions();
        renderAnnouncements();
        renderTaskEventOptions();
        renderTaskAssigneeOptions();
        try {
            await loadMerch();
        } catch (error) {
            if (!isNetworkError(error)) showToast(error.message, true);
        }
        if (authenticatedStaff) {
            try {
                await loadProfile();
            } catch (error) {
                if (!isNetworkError(error)) showToast(error.message, true);
            }
        }
        if (currentView !== 'member' && document.getElementById('tab-tasks').classList.contains('hidden') === false) {
            await loadEventTasks();
        }
        await renderAttendanceWithQueuedCheckins();
        if (syncQueue) void syncOfflineCheckins();
    } catch (error) {
        if (error.message.includes('Sign in with a staff')) setView('member');
        if (!isNetworkError(error)) {
            showToast(error.message || 'Could not connect to the dashboard database.', true);
            return;
        }
        try {
            const [cachedMembers, cachedEvents, cachedAttendance] = await Promise.all([
                window.offlineStore.getSnapshot('members'),
                window.offlineStore.getSnapshot('events'),
                window.offlineStore.getSnapshot('attendance')
            ]);
            members = currentView === 'admin' ? cachedMembers || [] : (cachedMembers || []).map(({ nfc_uid, ...member }) => member);
            events = cachedEvents || [];
            attendance = cachedAttendance || [];
            pointAdjustments = [];
            renderDashboard();
            renderMembers();
            renderEvents();
            renderEventOptions();
            renderPointsMemberOptions();
            renderPointHistory();
            renderStaffPasswordOptions();
            announcements = [];
            renderAnnouncements();
            renderTaskEventOptions();
            renderTaskAssigneeOptions();
            await renderAttendanceWithQueuedCheckins();
            if ((!cachedMembers || !cachedEvents) && !offlineCacheWarningShown) {
                offlineCacheWarningShown = true;
                showToast('Offline. Open the dashboard online once while signed in to cache the roster and events for offline check-ins.', true);
            }
        } catch (storageError) {
            console.error('Could not load the offline dashboard cache:', storageError);
            showToast('Offline data could not be loaded on this device.', true);
        }
    }
}

function parseServerTimestamp(value) {
    if (!value) return null;
    const text = String(value);
    return new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`);
}

function renderStaffPasswordOptions() {
    const select = document.getElementById('staff-password-guild-id');
    if (!select) return;
    const selected = select.value;
    const accounts = members.filter((member) => member.role !== 'Admin' || member.custom_id === 'NCGG-001');
    select.innerHTML = '<option value="">Select an account</option>' + accounts.map((member) =>
        `<option value="${escapeHtml(member.custom_id)}">${escapeHtml(member.name)} · ${escapeHtml(member.custom_id)} · ${escapeHtml(member.role)}</option>`
    ).join('');
    if (accounts.some((member) => member.custom_id === selected)) select.value = selected;
}

function renderAnnouncements() {
    const container = document.getElementById('announcements-list');
    const countLabel = document.getElementById('announcement-count');
    const expandedIds = new Set(Array.from(container.querySelectorAll('.announcement-card[open]'), (card) => card.dataset.announcementId));
    const searchTerm = document.getElementById('announcement-search').value.trim().toLocaleLowerCase();
    const selectedRole = document.getElementById('announcement-role-filter').value.toLocaleLowerCase();
    const fromDate = document.getElementById('announcement-date-from').value;
    const toDate = document.getElementById('announcement-date-to').value;
    const sortOrder = document.getElementById('announcement-sort').value;
    const visibleAnnouncements = announcements.filter((announcement) => {
        const content = `${announcement.title} ${announcement.body} ${announcement.author_name} ${announcement.author_role} ${announcement.media_filename || ''}`.toLocaleLowerCase();
        const createdAt = parseServerTimestamp(announcement.created_at);
        const announcementDate = createdAt && !Number.isNaN(createdAt.valueOf()) ? getGuildDateString(createdAt) : '';
        return (!searchTerm || content.includes(searchTerm))
            && (!selectedRole || String(announcement.author_role).toLocaleLowerCase() === selectedRole)
            && (!fromDate || (announcementDate && announcementDate >= fromDate))
            && (!toDate || (announcementDate && announcementDate <= toDate));
    }).sort((left, right) => {
        const leftTime = parseServerTimestamp(left.created_at)?.valueOf() || 0;
        const rightTime = parseServerTimestamp(right.created_at)?.valueOf() || 0;
        return (sortOrder === 'oldest' ? leftTime - rightTime : rightTime - leftTime) || Number(right.id) - Number(left.id);
    });
    countLabel.textContent = visibleAnnouncements.length === announcements.length
        ? `${announcements.length} ${announcements.length === 1 ? 'POST' : 'POSTS'}`
        : `${visibleAnnouncements.length} OF ${announcements.length} POSTS`;
    if (!announcements.length) {
        container.innerHTML = '<div class="empty-state">No announcements yet.</div>';
        return;
    }
    if (!visibleAnnouncements.length) {
        container.innerHTML = '<div class="empty-state announcement-empty">No announcements match these filters. Try changing your search or date range.</div>';
        return;
    }
    container.innerHTML = visibleAnnouncements.map((announcement) => {
        const date = parseServerTimestamp(announcement.created_at);
        const dateText = date && !Number.isNaN(date.valueOf())
            ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
            : '';
        const announcementId = Number(announcement.id);
        const expanded = expandedIds.has(String(announcementId));
        const reactionCounts = announcement.reaction_counts || {};
        const visibleReactions = [...new Set([
            ...ANNOUNCEMENT_REACTIONS.filter((reaction) =>
                ['👍', '❤️', '🎮', '🔥'].includes(reaction)
                || Number(reactionCounts[reaction] || 0) > 0
                || announcement.user_reaction === reaction
            ),
            ...Object.keys(reactionCounts).filter((reaction) => Number(reactionCounts[reaction]) > 0),
            ...(announcement.user_reaction ? [announcement.user_reaction] : [])
        ])];
        const pickerOpen = openAnnouncementReactionPickers.has(announcementId);
        return `<details class="panel announcement-card" data-announcement-id="${announcementId}"${expanded ? ' open' : ''}>
            <summary class="announcement-summary">
                <span class="announcement-heading">
                    <span class="announcement-title">${escapeHtml(announcement.title)}</span>
                    <span class="announcement-meta">${escapeHtml(announcement.author_name)} · ${escapeHtml(announcement.author_role)}${dateText ? ` · ${escapeHtml(dateText)}` : ''}</span>
                </span>
                <span class="announcement-expand" aria-hidden="true"></span>
            </summary>
            <div class="announcement-expanded">
                <p class="announcement-body">${escapeHtml(announcement.body)}</p>
                ${announcement.media_type?.startsWith('image/')
        ? `<img class="announcement-media" src="/api/announcements/${announcementId}/media" alt="${escapeHtml(announcement.media_filename || 'Announcement image')}" loading="lazy">`
        : announcement.media_type?.startsWith('video/')
            ? `<video class="announcement-media" controls preload="metadata"><source src="/api/announcements/${announcementId}/media" type="${escapeHtml(announcement.media_type)}">Your browser cannot play this video.</video>`
            : ''}
                <div class="announcement-reactions" role="group" aria-label="Reactions">
                ${visibleReactions.map((reaction) => {
                    const count = Number(reactionCounts[reaction] || 0);
                    const selected = announcement.user_reaction === reaction;
                    return `<button class="announcement-reaction${selected ? ' selected' : ''}" type="button" data-announcement-reaction="${announcementId}" data-reaction="${reaction}" aria-pressed="${selected}" aria-label="${reaction} reaction, ${count} ${count === 1 ? 'reaction' : 'reactions'}"${pendingAnnouncementReactions.has(announcementId) ? ' disabled' : ''}>
                        <span aria-hidden="true">${reaction}</span><span>${count}</span>
                    </button>`;
                }).join('')}
                    <button class="announcement-add-reaction" type="button" data-reaction-picker="${announcementId}" aria-expanded="${pickerOpen}" aria-label="${pickerOpen ? 'Close' : 'Add'} an emoji reaction">＋</button>
                </div>
                ${pickerOpen ? `<div class="announcement-emoji-picker" role="group" aria-label="Choose an emoji reaction">${ANNOUNCEMENT_REACTIONS.map((reaction) =>
                    `<button class="announcement-emoji-option${announcement.user_reaction === reaction ? ' selected' : ''}" type="button" data-announcement-reaction="${announcementId}" data-reaction="${reaction}" aria-label="React with ${reaction}" aria-pressed="${announcement.user_reaction === reaction}"${pendingAnnouncementReactions.has(announcementId) ? ' disabled' : ''}>${reaction}</button>`
                ).join('')}
                    <div class="announcement-custom-reaction">
                        <label for="announcement-custom-reaction-${announcementId}">Use any emoji</label>
                        <div><input class="field" id="announcement-custom-reaction-${announcementId}" type="text" maxlength="32" inputmode="text" placeholder="Paste an emoji" aria-label="Enter a custom emoji reaction" data-custom-reaction-input="${announcementId}">
                        <button class="button button-secondary" type="button" data-custom-reaction="${announcementId}"${pendingAnnouncementReactions.has(announcementId) ? ' disabled' : ''}>React</button></div>
                    </div>
                </div>` : ''}
            </div>
        </details>`;
    }).join('');
}

function projectStatusOptions(selected) {
    return ['Not started', 'Working on it', 'Stuck', 'Done'].map((status) =>
        `<option value="${status}"${status === selected ? ' selected' : ''}>${status}</option>`
    ).join('');
}

function renderProjectBoard() {
    const container = document.getElementById('project-group-list');
    const staffOptions = members
        .filter((member) => ['Officer', 'Executive', 'Admin'].includes(member.role) && member.custom_id)
        .map((member) => `<option value="${escapeHtml(member.custom_id)}">${escapeHtml(member.name)} · ${escapeHtml(member.custom_id)}</option>`)
        .join('');
    container.innerHTML = projectBoard.groups.length ? projectBoard.groups.map((group) => `
        <section class="project-group panel" data-project-group="${Number(group.id)}">
            <div class="project-group-heading"><h3>${escapeHtml(group.name)}</h3><span>${group.items.length} ${group.items.length === 1 ? 'item' : 'items'}</span></div>
            <div class="project-table-wrap">
                <table class="project-table">
                    <thead><tr><th>Item</th><th>Status</th><th>Assignee</th><th>Due date</th></tr></thead>
                    <tbody>${group.items.map((item) => `<tr data-project-item="${Number(item.id)}">
                        <td><input class="field project-cell-title" data-project-field="title" aria-label="Item name" value="${escapeHtml(item.title)}" maxlength="160"></td>
                        <td><select class="field project-status status-${item.status.toLowerCase().replace(/\s+/g, '-')}" data-project-field="status" aria-label="Status">${projectStatusOptions(item.status)}</select></td>
                        <td><select class="field" data-project-field="assignee" aria-label="Assignee"><option value="">Unassigned</option>${staffOptions.replace(`value="${escapeHtml(item.assignee)}"`, `value="${escapeHtml(item.assignee)}" selected`)}</select></td>
                        <td><input class="field project-date-field" type="date" data-project-field="due_date" aria-label="Due date" value="${escapeHtml(item.due_date || '')}"></td>
                    </tr>`).join('')}</tbody>
                </table>
            </div>
            <form class="project-add-item-form" data-project-add-item="${Number(group.id)}">
                <input class="field" name="title" maxlength="160" required placeholder="Add an item to ${escapeHtml(group.name)}">
                <button class="button button-secondary" type="submit">＋ Add item</button>
            </form>
        </section>
    `).join('') : '<div class="empty-state">No groups yet. Add a group to begin organizing items.</div>';
}

async function loadProjectBoard(boardId) {
    if (!boardId) {
        projectBoard = null;
        document.getElementById('project-board-view').classList.add('hidden');
        document.getElementById('project-empty-state').classList.toggle('hidden', projectWorkspaces.length === 0);
        return;
    }
    projectBoard = await api(`/api/project-boards/${encodeURIComponent(boardId)}`);
    const workspace = projectWorkspaces.find((item) => String(item.id) === String(projectBoard.workspace_id));
    document.getElementById('project-workspace-name').textContent = workspace?.name || '';
    document.getElementById('project-board-name').textContent = projectBoard.name;
    document.getElementById('project-board-view').classList.remove('hidden');
    document.getElementById('project-empty-state').classList.add('hidden');
    renderProjectBoard();
}

async function loadProjectBoards(workspaceId, selectedBoardId = '') {
    const select = document.getElementById('project-board-select');
    const createButton = document.getElementById('project-new-board');
    if (!workspaceId) {
        projectBoards = [];
        select.innerHTML = '<option value="">Select board</option>';
        select.disabled = true;
        createButton.disabled = true;
        document.getElementById('project-empty-state-title').textContent = 'Start a project workspace';
        document.getElementById('project-empty-state-description').textContent = 'Create a workspace for a team, then add a board to organize its work.';
        document.querySelector('[data-create-workspace]').classList.remove('hidden');
        document.querySelector('[data-create-board]').classList.add('hidden');
        await loadProjectBoard('');
        return;
    }
    projectBoards = await api(`/api/project-workspaces/${encodeURIComponent(workspaceId)}/boards`);
    select.innerHTML = '<option value="">Select board</option>' + projectBoards.map((board) =>
        `<option value="${Number(board.id)}">${escapeHtml(board.name)}</option>`
    ).join('');
    select.disabled = false;
    createButton.disabled = false;
    if (!projectBoards.length) {
        projectBoard = null;
        document.getElementById('project-board-view').classList.add('hidden');
        document.getElementById('project-empty-state').classList.remove('hidden');
        document.getElementById('project-empty-state-title').textContent = 'Workspace created';
        document.getElementById('project-empty-state-description').textContent = 'Add a board to organize project work and create quests linked to this workspace.';
        document.querySelector('[data-create-workspace]').classList.add('hidden');
        document.querySelector('[data-create-board]').classList.remove('hidden');
        return;
    }
    document.getElementById('project-empty-state').classList.add('hidden');
    const nextBoardId = projectBoards.some((board) => String(board.id) === String(selectedBoardId))
        ? String(selectedBoardId)
        : projectBoards.length ? String(projectBoards[0].id) : '';
    select.value = nextBoardId;
    await loadProjectBoard(nextBoardId);
}

async function loadProjectWorkspaces(selectedWorkspaceId = '') {
    projectWorkspaces = await api('/api/project-workspaces');
    updateTaskWorkspaceOptions();
    const select = document.getElementById('project-workspace-select');
    select.innerHTML = '<option value="">Select workspace</option>' + projectWorkspaces.map((workspace) =>
        `<option value="${Number(workspace.id)}">${escapeHtml(workspace.name)}</option>`
    ).join('');
    const nextWorkspaceId = projectWorkspaces.some((workspace) => String(workspace.id) === String(selectedWorkspaceId))
        ? String(selectedWorkspaceId)
        : projectWorkspaces.length ? String(projectWorkspaces[0].id) : '';
    select.value = nextWorkspaceId;
    await loadProjectBoards(nextWorkspaceId);
    if (!projectWorkspaces.length) {
        document.getElementById('project-board-view').classList.add('hidden');
        document.getElementById('project-empty-state').classList.remove('hidden');
    }
}

async function loadProjectWorkspaceOptions() {
    projectWorkspaces = await api('/api/project-workspaces');
    updateTaskWorkspaceOptions();
}

function updateTaskWorkspaceOptions() {
    const select = document.getElementById('task-workspace-create');
    if (!select) return;
    const selected = select.value;
    select.innerHTML = '<option value="">No workspace</option>' + projectWorkspaces.map((workspace) =>
        `<option value="${Number(workspace.id)}">${escapeHtml(workspace.name)}</option>`
    ).join('');
    if (projectWorkspaces.some((workspace) => String(workspace.id) === selected)) select.value = selected;
}

function renderTaskEventOptions() {
    const select = document.getElementById('task-event-select');
    if (!select) return;
    const selected = select.value;
    select.innerHTML = '<option value="">All events</option>' + events.map((event) =>
        `<option value="${Number(event.id)}">${escapeHtml(event.name)} · ${escapeHtml(event.event_date)}</option>`
    ).join('');
    if (events.some((event) => String(event.id) === selected)) select.value = selected;
    const selectedEvent = events.find((event) => String(event.id) === select.value);
    const note = document.getElementById('task-selected-event-note');
    if (note) note.textContent = selectedEvent
        ? `${selectedEvent.event_date}${selectedEvent.closed_at ? ' · Closed event' : ' · Active event'}`
        : 'All events · independent tasks included';
    const createSelect = document.getElementById('task-event-create');
    if (createSelect) {
        const createValue = createSelect.value;
        createSelect.innerHTML = '<option value="">General task (not event-linked)</option>' + events.map((event) =>
            `<option value="${Number(event.id)}">${escapeHtml(event.name)} · ${escapeHtml(event.event_date)}</option>`
        ).join('');
        if (events.some((event) => String(event.id) === createValue)) createSelect.value = createValue;
    }
}

function renderTaskAssigneeOptions() {
    const guildMembers = members.filter((member) => member.custom_id);
    const options = guildMembers.map((member) =>
        `<option value="${escapeHtml(member.custom_id)}">${escapeHtml(member.name)} · ${escapeHtml(member.custom_id)} · ${escapeHtml(member.role)}</option>`
    ).join('');
    const createSelect = document.getElementById('task-assignees');
    const filterSelect = document.getElementById('task-filter-assignee');
    if (createSelect) createSelect.innerHTML = options || '<option disabled>No staff members available</option>';
    if (filterSelect) {
        const selected = filterSelect.value;
        filterSelect.innerHTML = '<option value="">All assignees</option>' + options;
        if (guildMembers.some((member) => member.custom_id === selected)) filterSelect.value = selected;
    }
}

async function loadEventTasks() {
    const eventId = document.getElementById('task-event-select').value;
    const container = document.getElementById('event-task-list');
    try {
        eventTasks = await api(eventId ? `/api/tasks?event_id=${encodeURIComponent(eventId)}` : '/api/tasks');
        renderEventTasks();
    } catch (error) {
        container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
}

function renderEventTasks() {
    const container = document.getElementById('event-task-list');
    const expandedTaskIds = new Set(Array.from(
        container.querySelectorAll('.task-details[open]'),
        (details) => details.closest('[data-task-card]')?.dataset.taskCard
    ).filter(Boolean));
    const statusFilter = document.getElementById('task-filter-status').value;
    const priorityFilter = document.getElementById('task-filter-priority').value;
    const assigneeFilter = document.getElementById('task-filter-assignee').value;
    const search = document.getElementById('task-search').value.trim().toLowerCase();
    const statusForTask = (task) => task.status || (Number(task.progress) >= 100 ? 'Complete' : Number(task.progress) > 0 ? 'Open' : 'Not started');
    const visibleTasks = eventTasks.filter((task) => {
        const assignees = task.assignees || [];
        const assigneeMembers = members.filter((member) => assignees.includes(member.custom_id));
        const searchable = `${task.title} ${task.committee} ${task.description} ${assigneeMembers.map((member) => `${member.name} ${member.custom_id}`).join(' ')}`.toLowerCase();
        return (!statusFilter || statusForTask(task) === statusFilter)
            && (!priorityFilter || task.priority === priorityFilter)
            && (!assigneeFilter || assignees.includes(assigneeFilter))
            && (!search || searchable.includes(search));
    });
    const lanes = [
        { status: 'Not started', label: 'Not started', className: 'todo' },
        { status: 'Open', label: 'In progress', className: 'in-progress' },
        { status: 'Complete', label: 'Completed', className: 'done' }
    ];
    const totalProgress = visibleTasks.length
        ? Math.round(visibleTasks.reduce((total, task) => total + (statusForTask(task) === 'Complete' ? 100 : Number(task.progress || 0)), 0) / visibleTasks.length)
        : 0;
    const taskGroups = new Map();
    for (const task of eventTasks) {
        const key = `${String(task.workspace_id || 'none')}:${String(task.event_id || 'general')}`;
        if (!taskGroups.has(key)) {
            taskGroups.set(key, {
                name: `${task.workspace_name ? `${task.workspace_name} · ` : ''}${task.event_name || 'General tasks (not linked to an event)'}`,
                tasks: []
            });
        }
        taskGroups.get(key).tasks.push(task);
    }
    const laneMarkup = Array.from(taskGroups, ([key, group]) => {
        const groupVisibleTasks = visibleTasks.filter((task) =>
            `${String(task.workspace_id || 'none')}:${String(task.event_id || 'general')}` === key
        );
        const groupLanes = lanes.map((lane) => {
        const tasks = groupVisibleTasks.filter((task) => statusForTask(task) === lane.status);
        const cards = tasks.map((task) => {
            const taskId = Number(task.id);
            const formId = `task-update-${taskId}`;
            const priority = String(task.priority || 'Medium');
            const status = statusForTask(task);
            const taskAssigneeIds = task.assignees || [];
            const taskMembers = members.filter((member) => member.custom_id);
            const subtasks = task.subtasks || [];
            const comments = task.comments || [];
            const attachments = task.attachments || [];
            const completedSubtasks = subtasks.filter((subtask) => subtask.completed === true || Number(subtask.completed) === 1).length;
            const progress = status === 'Complete' ? 100 : Math.max(0, Math.min(100, Number(task.progress || 0)));
            const isOverdue = task.deadline && task.deadline < getGuildDateString() && status !== 'Complete';
            const detailCount = `${completedSubtasks}/${subtasks.length} steps · ${comments.length} comments · ${attachments.length + (task.link_url ? 1 : 0)} files`;
            const assigneeDisplay = taskMembers.filter((member) => taskAssigneeIds.includes(member.custom_id));

            return `<article class="task-board-card" id="task-row-${taskId}" data-task-card="${taskId}">
                <form id="${formId}" data-task-update="${taskId}"></form>
                <div class="task-card-topline">
                    <span class="task-committee-label">${escapeHtml(task.committee)}</span>
                    <span class="task-priority-badge priority-${priority.toLowerCase()}"><span aria-hidden="true"></span>${escapeHtml(priority)}</span>
                </div>
                <h3 class="task-card-title">${escapeHtml(task.title)}</h3>
                ${task.description ? `<p class="task-card-description">${escapeHtml(task.description)}</p>` : ''}
                <div class="task-card-progress"><div><span>Progress</span><strong>${progress}%</strong></div><progress max="100" value="${progress}" aria-label="Task progress ${progress}%"></progress></div>
                <div class="task-card-meta">
                    <span class="task-card-deadline${isOverdue ? ' overdue' : ''}">${task.deadline ? `${isOverdue ? 'Overdue · ' : 'Due '}${escapeHtml(formatGuildDate(task.deadline))}` : 'No deadline'}</span>
                    <span class="task-card-assignees" aria-label="${assigneeDisplay.length ? 'Assigned to ' + assigneeDisplay.map((member) => member.name).join(', ') : 'Unassigned'}">
                        ${assigneeDisplay.length ? assigneeDisplay.slice(0, 3).map((member) => `<span class="task-assignee-avatar" title="${escapeHtml(member.name)}">${escapeHtml(member.name.trim().split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase())}</span>`).join('') : '<span class="task-unassigned">Unassigned</span>'}
                        ${assigneeDisplay.length > 3 ? `<span class="task-assignee-extra">+${assigneeDisplay.length - 3}</span>` : ''}
                    </span>
                </div>
                <div class="task-card-actions">
                    <select class="field task-status-select status-${status.toLowerCase().replace(/\s+/g, '-')}" name="status" form="${formId}" aria-label="Status for ${escapeHtml(task.title)}">
                        ${[['Not started', 'Not started'], ['Open', 'In progress'], ['Complete', 'Completed']].map(([value, label]) => `<option value="${value}"${status === value ? ' selected' : ''}>${label}</option>`).join('')}
                    </select>
                    <button class="button task-save-button" type="submit" form="${formId}">Save</button>
                </div>
                <details class="task-details"${expandedTaskIds.has(String(taskId)) ? ' open' : ''}>
                    <summary><span>${detailCount}</span><span class="task-card-details-toggle">Details</span></summary>
                    <div class="task-details-content">
                        <section class="task-card-settings">
                            <h4>Schedule &amp; ownership</h4>
                            <div class="task-card-settings-grid">
                                <label>PRIORITY<select class="field task-priority-select priority-${priority.toLowerCase()}" name="priority" form="${formId}" aria-label="Priority for ${escapeHtml(task.title)}">
                                    <option${priority === 'Low' ? ' selected' : ''}>Low</option>
                                    <option${priority === 'Medium' ? ' selected' : ''}>Medium</option>
                                    <option${priority === 'High' ? ' selected' : ''}>High</option>
                                </select></label>
                                <label>DEADLINE<input class="field task-deadline-input${isOverdue ? ' overdue' : ''}" type="date" name="deadline" form="${formId}" value="${escapeHtml(task.deadline || '')}" aria-label="Deadline for ${escapeHtml(task.title)}"></label>
                                <label class="task-assignees-field">ASSIGNED MEMBERS<select class="field task-assignees-select" name="assignees" form="${formId}" multiple aria-label="Assigned members for ${escapeHtml(task.title)}" size="4">
                                    ${taskMembers.map((member) => `<option value="${escapeHtml(member.custom_id)}"${taskAssigneeIds.includes(member.custom_id) ? ' selected' : ''}>${escapeHtml(member.name)} · ${escapeHtml(member.custom_id)} · ${escapeHtml(member.role)}</option>`).join('')}
                                </select><small>Hold Ctrl (Windows) or Command (Mac) to select more than one.</small></label>
                            </div>
                        </section>
                        <section class="task-edit-section"><h4>Edit task</h4>
                            <form class="task-edit-form" data-task-edit="${taskId}">
                                <label>TASK TITLE<input class="field" name="title" maxlength="160" required value="${escapeHtml(task.title)}"></label>
                                <label>COMMITTEE<input class="field" name="committee" maxlength="100" required value="${escapeHtml(task.committee)}"></label>
                                <label>WORKSPACE<select class="field" name="workspace_id"><option value="">No workspace</option>${projectWorkspaces.map((workspace) =>
                                    `<option value="${Number(workspace.id)}"${String(task.workspace_id) === String(workspace.id) ? ' selected' : ''}>${escapeHtml(workspace.name)}</option>`
                                ).join('')}</select></label>
                                <label>QUEST REWARD (POINTS)<input class="field" name="points_reward" type="number" min="1" max="10000" step="1" required value="${Number(task.points_reward || 1)}"></label>
                                <label class="task-edit-wide">DETAILS<textarea class="field reason-field" name="description" maxlength="5000">${escapeHtml(task.description || '')}</textarea></label>
                                <label class="task-edit-wide">LINK<input class="field" name="link_url" type="url" maxlength="2000" value="${escapeHtml(task.link_url || '')}" placeholder="https://…"></label>
                                <button class="button button-secondary" type="submit">Save task details</button>
                                <button class="button button-delete task-delete-button" type="button" data-delete-task="${taskId}">Delete task</button>
                            </form>
                        </section>
                        <section class="task-subtasks"><h4>Subtasks (${completedSubtasks}/${subtasks.length} complete)</h4>
                            ${subtasks.length ? subtasks.map((subtask) => `<div class="task-subtask${subtask.completed === true || Number(subtask.completed) === 1 ? ' completed' : ''}">
                                <label><input type="checkbox" data-subtask-toggle="${Number(subtask.id)}" data-task-id="${taskId}"${subtask.completed === true || Number(subtask.completed) === 1 ? ' checked' : ''}> <span>${escapeHtml(subtask.title)}</span></label>
                                <button class="button button-delete" type="button" data-delete-subtask="${Number(subtask.id)}" data-task-id="${taskId}" aria-label="Delete subtask ${escapeHtml(subtask.title)}">Delete</button>
                            </div>`).join('') : '<p class="muted task-no-comments">No subtasks yet.</p>'}
                            <form class="task-subtask-form" data-task-subtask="${taskId}"><input class="field" name="title" maxlength="160" required placeholder="Add a subtask"><button class="button button-secondary" type="submit">Add subtask</button></form>
                        </section>
                        <section class="task-comments"><h4>Comments (${comments.length})</h4>
                            ${comments.length ? comments.map((comment) => {
                                const date = parseServerTimestamp(comment.created_at);
                                const dateText = date && !Number.isNaN(date.valueOf()) ? date.toLocaleString() : '';
                                return `<p class="task-comment"><strong>${escapeHtml(comment.author_name)}</strong>${dateText ? `<small>${escapeHtml(dateText)}</small>` : ''}<span>${escapeHtml(comment.body)}</span></p>`;
                            }).join('') : '<p class="muted task-no-comments">No comments yet.</p>'}
                            <form class="task-comment-form" data-task-comment="${taskId}"><input class="field" name="body" maxlength="2000" required placeholder="Add a comment"><button class="button button-secondary" type="submit">Comment</button></form>
                        </section>
                        <section class="task-attachments"><h4>Files and links</h4>
                            ${task.link_url ? `<a class="task-attachment" href="${escapeHtml(task.link_url)}" target="_blank" rel="noopener noreferrer">↗ Open task link</a>` : ''}
                            ${attachments.map((attachment) => {
                                const attachmentUrl = `/api/tasks/${taskId}/attachments/${Number(attachment.id)}`;
                                return attachment.mime_type?.startsWith('image/')
                                    ? `<a class="task-image-attachment" href="${attachmentUrl}" target="_blank" rel="noopener noreferrer"><img src="${attachmentUrl}" alt="${escapeHtml(attachment.filename)}" loading="lazy"><span>${escapeHtml(attachment.filename)}</span></a>`
                                    : `<a class="task-attachment" href="${attachmentUrl}" target="_blank" rel="noopener noreferrer">↗ ${escapeHtml(attachment.filename)}</a>`;
                            }).join('')}
                            ${!task.link_url && !attachments.length ? '<p class="muted task-no-comments">No files or links attached.</p>' : ''}
                            <form class="task-attachment-form" data-task-attachment="${taskId}">
                                <input class="field" type="file" name="files" accept="application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png,image/gif,.gif,image/webp,.webp" multiple required>
                                <span class="task-upload-hint">Add images or PDFs · up to 5 MB each</span>
                                <button class="button button-secondary" type="submit">Upload files</button>
                            </form>
                        </section>
                    </div>
                </details>
            </article>`;
        }).join('');
        return `<section class="task-lane task-lane-${lane.className}" aria-label="${lane.label}">
            <header class="task-lane-header"><span class="task-lane-indicator" aria-hidden="true"></span><h3>${lane.label}</h3><span class="task-lane-count">${tasks.length}</span></header>
            <div class="task-lane-cards">${cards || `<p class="task-lane-empty">${eventTasks.length ? 'No tasks in this lane.' : 'Add a task to get started.'}</p>`}</div>
        </section>`;
        }).join('');
        return `<section class="task-event-group"><h2 class="task-event-group-title">${escapeHtml(group.name)}</h2><div class="task-board">${groupLanes}</div></section>`;
    }).join('');
    container.innerHTML = `<section class="task-board-overview" aria-label="Task progress">
        <div><span>${visibleTasks.length} ${visibleTasks.length === 1 ? 'task' : 'tasks'}${visibleTasks.length !== eventTasks.length ? ` · ${eventTasks.length} total` : ''}</span><strong>${totalProgress}% complete</strong></div>
        <progress max="100" value="${totalProgress}" aria-label="Overall progress ${totalProgress}%"></progress>
    </section>
    ${visibleTasks.length ? laneMarkup : `<div class="empty-state task-filter-empty">${eventTasks.length ? 'No tasks match the selected filters.' : 'No tasks in this workspace yet. Add a task above.'}</div>`}`;
    renderTaskCalendar(visibleTasks);
}

function renderTaskCalendar(tasks = eventTasks) {
    const calendar = document.getElementById('task-calendar');
    const year = taskCalendarDate.getFullYear();
    const month = taskCalendarDate.getMonth();
    document.getElementById('task-calendar-month').textContent =
        taskCalendarDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const slotCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const todayString = getGuildDateString();
    const tasksByDeadline = new Map();
    tasks.filter((task) => task.deadline).forEach((task) => {
        if (!tasksByDeadline.has(task.deadline)) tasksByDeadline.set(task.deadline, []);
        tasksByDeadline.get(task.deadline).push(task);
    });
    const dayCells = Array.from({ length: slotCount }, (_, index) => {
        const day = index - firstWeekday + 1;
        if (day < 1 || day > daysInMonth) return '<div class="calendar-day outside-month" aria-hidden="true"></div>';
        const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayTasks = tasksByDeadline.get(dateKey) || [];
        return `<div class="calendar-day${dateKey === todayString ? ' today' : ''}" aria-label="${dateKey}, ${dayTasks.length} tasks">
            <span class="calendar-day-number">${day}</span>
            <div class="calendar-day-tasks">${dayTasks.map((task) =>
                `<button class="calendar-task-chip priority-${String(task.priority).toLowerCase()}${Number(task.progress) === 100 ? ' completed' : ''}" type="button" data-calendar-task="${Number(task.id)}" title="${escapeHtml(task.committee)} · ${escapeHtml(task.title)}">
                    <span>${escapeHtml(task.committee)}</span>${escapeHtml(task.title)}
                </button>`
            ).join('')}</div>
        </div>`;
    }).join('');
    calendar.innerHTML = `<div class="calendar-weekdays">${weekdays.map((weekday) => `<span>${weekday}</span>`).join('')}</div>
        <div class="calendar-days">${dayCells}</div>
        ${!tasksByDeadline.size ? '<p class="calendar-empty-note">No tasks have deadlines yet. Add a deadline to a task to see it on this calendar.</p>' : ''}`;
}

function setTaskView(view) {
    taskView = view;
    const showCalendar = view === 'calendar';
    document.getElementById('task-calendar-view').classList.toggle('hidden', !showCalendar);
    document.getElementById('event-task-list').classList.toggle('hidden', showCalendar);
    document.querySelectorAll('[data-task-view]').forEach((button) => {
        const selected = button.dataset.taskView === view;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
    });
}

function renderDashboard() {
    const today = getGuildDateString();
    const regularMembers = members.filter((member) => member.role === 'Member');
    const staff = members.filter((member) => member.role !== 'Member');
    document.getElementById('stat-members').textContent = regularMembers.length;
    document.getElementById('stat-events').textContent = events.filter((event) => !event.closed_at && event.event_date >= today).length;
    document.getElementById('stat-points').textContent = members.reduce((total, member) => total + Number(member.points || 0), 0).toLocaleString();

    const renderLeaderboard = (rows, tbodyId, emptyText, detail) => {
        const tbody = document.getElementById(tbodyId);
        const leaderboard = [...rows].sort((a, b) => Number(b.points || 0) - Number(a.points || 0)).slice(0, 10);
        tbody.innerHTML = leaderboard.length ? leaderboard.map((member, index) => `
        <tr>
            <td><span class="rank ${index < 3 ? 'rank-highlight' : ''}">#${index + 1}</span></td>
            <td><strong>${escapeHtml(member.name)}</strong><small class="table-subtext">${escapeHtml(member.custom_id || '—')}</small></td>
            <td><span class="role-pill">${escapeHtml(detail(member))}</span></td>
            <td class="align-right points-cell">${Number(member.points || 0).toLocaleString()}</td>
        </tr>`).join('') : `<tr><td colspan="4" class="empty-cell">${emptyText}</td></tr>`;
    };
    renderLeaderboard(regularMembers, 'leaderboard-body', 'No members registered yet.', (member) => member.tier || 'Regular');
    renderLeaderboard(staff, 'staff-leaderboard-body', 'No officers registered yet.', (member) => member.role);
}

async function loadProfile() {
    const result = await api('/api/profile');
    profileAttendance = result.attendance;
    document.getElementById('profile-name').textContent = result.profile.name;
    document.getElementById('profile-role').textContent = result.profile.role.toUpperCase();
    document.getElementById('profile-points').textContent = Number(result.profile.points || 0).toLocaleString();
    document.getElementById('profile-attendance-count').textContent = result.attendance.length.toLocaleString();
    document.getElementById('profile-guild-id').textContent = result.profile.custom_id || '—';
    document.getElementById('profile-tier').textContent = result.profile.role === 'member'
        ? (result.profile.tier || 'Regular')
        : 'Guild staff';
    document.getElementById('profile-attendance-body').innerHTML = result.attendance.length
        ? result.attendance.map((item) => {
            const date = parseServerTimestamp(item.timestamp);
            const dateText = date && !Number.isNaN(date.valueOf())
                ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
                : '—';
            return `<tr><td><strong>${escapeHtml(item.event_name)}</strong></td><td>${escapeHtml(dateText)}</td><td class="align-right points-cell">+${Number(item.points_awarded || 0).toLocaleString()}</td></tr>`;
        }).join('')
        : '<tr><td colspan="3" class="empty-cell">No attendance records yet.</td></tr>';

    await loadProfileTasks();
    if (!profileTaskPollTimer) {
        profileTaskPollTimer = window.setInterval(() => {
            if (!authenticatedStaff) return;
            void loadProfileTasks(true).catch((error) => {
                if (!isNetworkError(error)) showToast(error.message, true);
            });
        }, 30000);
    }
}

async function loadProfileTasks(notifyNewAssignments = false) {
    const tasks = await api('/api/profile/tasks');
    const previousIds = new Set(profileTasks.map((task) => String(task.id)));
    const newAssignments = tasks.filter((task) => !previousIds.has(String(task.id)));
    profileTasks = tasks;
    const submittedCount = tasks.filter((task) => task.submitted === true || Number(task.submitted) === 1).length;
    const earnedPoints = tasks.reduce((total, task) => total +
        (task.submitted === true || Number(task.submitted) === 1 ? Number(task.points_awarded ?? task.points_reward ?? 0) : 0), 0);
    const notice = document.getElementById('profile-task-notice');
    notice.textContent = tasks.length
        ? `${tasks.length} quest${tasks.length === 1 ? '' : 's'} · ${submittedCount} submitted · ${earnedPoints.toLocaleString()} quest points earned.`
        : 'No quests are currently assigned to your guild ID.';
    document.getElementById('profile-task-list').innerHTML = tasks.length ? tasks.map((task) =>
        `<article class="profile-task">
            <div class="profile-task-copy">
                <strong>${escapeHtml(task.title)}</strong>
                <small>${escapeHtml(task.workspace_name ? `${task.workspace_name} · ` : '')}${escapeHtml(task.event_name || 'General task')} · ${escapeHtml(task.committee)} · ${escapeHtml(task.priority)} priority</small>
                ${task.description ? `<small class="profile-task-description">${escapeHtml(task.description)}</small>` : ''}
                ${task.deadline ? `<small>Due ${escapeHtml(formatGuildDate(task.deadline))}</small>` : ''}
            </div>
            <span class="role-pill">${escapeHtml(task.status)}</span>
            <button class="button button-secondary profile-task-submit" type="button" data-task-submission="${Number(task.id)}" data-submitted="${task.submitted ? 'true' : 'false'}">
                ${task.submitted ? `Undo submission (−${Number(task.points_awarded ?? task.points_reward ?? 0)} points)` : `Submit quest (+${Number(task.points_reward || 0)} points)`}
            </button>
        </article>`
    ).join('') : '<p class="empty-state">No tasks assigned to you.</p>';
    if (notifyNewAssignments && newAssignments.length) {
        showToast(`You have ${newAssignments.length} new task assignment${newAssignments.length === 1 ? '' : 's'}.`);
    }
}

function clearPrivateProfileData() {
    profileAttendance = [];
    profileTasks = [];
    document.getElementById('profile-name').textContent = 'My guild profile';
    document.getElementById('profile-role').textContent = 'MEMBER';
    document.getElementById('profile-points').textContent = '0';
    document.getElementById('profile-attendance-count').textContent = '0';
    document.getElementById('profile-guild-id').textContent = '—';
    document.getElementById('profile-tier').textContent = 'Guild member';
    document.getElementById('profile-attendance-body').innerHTML = '<tr><td colspan="3" class="empty-cell">No attendance records yet.</td></tr>';
    document.getElementById('profile-task-notice').textContent = '';
    document.getElementById('profile-task-list').replaceChildren();
}

async function loadMerch() {
    merchItems = await api('/api/merch');
    renderMerch();
}

function renderMerch() {
    const container = document.getElementById('merch-list');
    const isAdmin = currentView === 'admin';
    const searchTerm = document.getElementById('merch-search').value.trim().toLocaleLowerCase();
    const stockFilter = document.getElementById('merch-stock-filter').value;
    document.getElementById('merch-add-product-button').classList.toggle('hidden', !isAdmin);
    document.getElementById('merch-intro').textContent = isAdmin
        ? 'Add products to the catalog, update stock, and build an order preview.'
        : 'Build an order preview and check current prices and stock. Contact a guild officer to arrange a purchase.';
    container.classList.toggle('merch-admin-view', isAdmin);
    const visibleItems = merchItems.filter((item) => {
        const searchable = `${item.name} ${item.description || ''}`.toLocaleLowerCase();
        return (!searchTerm || searchable.includes(searchTerm))
            && (stockFilter === 'all'
                || (stockFilter === 'available' && Number(item.inventory) > 0)
                || (stockFilter === 'sold-out' && Number(item.inventory) === 0));
    });
    document.getElementById('merch-results-count').textContent =
        `${visibleItems.length} ${visibleItems.length === 1 ? 'item' : 'items'}`;
    container.innerHTML = visibleItems.length ? visibleItems.map((item) =>
        `<article class="panel merch-card${Number(item.inventory) === 0 ? ' merch-sold-out' : ''}">
            ${item.image_type ? `<img class="merch-product-image" src="/api/merch/${Number(item.id)}/image" alt="${escapeHtml(item.name)}" loading="lazy">` : '<div class="merch-image-placeholder" aria-hidden="true">NCGG</div>'}
            <div class="merch-card-body">
                <span class="merch-stock ${Number(item.inventory) > 0 ? 'in-stock' : 'out-of-stock'}">${Number(item.inventory) > 0 ? (isAdmin ? `${Number(item.inventory)} IN STOCK` : `${Number(item.inventory)} available`) : 'Out of stock'}</span>
                <h2>${escapeHtml(item.name)}</h2><p>${escapeHtml(item.description || 'Guild merchandise')}</p>
                <strong class="merch-price">${formatMerchPrice(item.price_cents)}</strong>
                <button class="button button-primary pos-add-button" type="button" data-add-to-cart="${Number(item.id)}"${Number(item.inventory) < 1 ? ' disabled' : ''}>
                    ${Number(item.inventory) < 1 ? 'Unavailable' : `＋ Add to order${merchCart.has(Number(item.id)) ? ` · ${merchCart.get(Number(item.id))} added` : ''}`}
                </button>
            </div>
            ${isAdmin ? `<div class="merch-admin-actions"><button class="button button-secondary" type="button" data-edit-merch="${Number(item.id)}">Edit</button><button class="button button-delete" type="button" data-delete-merch="${Number(item.id)}">Remove</button></div>` : ''}
        </article>`
    ).join('') : `<div class="empty-state">${merchItems.length ? 'No products match your search or stock filter.' : 'No merchandise listed yet.'}</div>`;
    renderMerchCart();
}

function renderMerchCart() {
    const container = document.getElementById('pos-cart-items');
    let totalCents = 0;
    const lines = Array.from(merchCart, ([itemId, quantity]) => {
        const item = merchItems.find((row) => Number(row.id) === itemId);
        if (!item || Number(item.inventory) < 1) {
            merchCart.delete(itemId);
            return '';
        }
        const availableQuantity = Math.min(quantity, Number(item.inventory));
        if (availableQuantity !== quantity) merchCart.set(itemId, availableQuantity);
        const lineTotal = Number(item.price_cents) * availableQuantity;
        totalCents += lineTotal;
        return `<article class="pos-cart-line">
            <div class="pos-cart-line-info"><strong>${escapeHtml(item.name)}</strong><small>${formatMerchPrice(item.price_cents)} each</small></div>
            <div class="pos-quantity-control" aria-label="${escapeHtml(item.name)} quantity">
                <button type="button" data-cart-change="${itemId}" data-quantity-delta="-1" aria-label="Decrease ${escapeHtml(item.name)} quantity">−</button>
                <span>${availableQuantity}</span>
                <button type="button" data-cart-change="${itemId}" data-quantity-delta="1" aria-label="Increase ${escapeHtml(item.name)} quantity"${availableQuantity >= Number(item.inventory) ? ' disabled' : ''}>＋</button>
            </div>
            <strong class="pos-line-total">${formatMerchPrice(lineTotal)}</strong>
            <button type="button" class="pos-remove-line" data-cart-remove="${itemId}" aria-label="Remove ${escapeHtml(item.name)} from order preview">Remove</button>
        </article>`;
    }).filter(Boolean);
    container.innerHTML = lines.length ? lines.join('') : '<p class="pos-cart-empty">Add products to start an order preview.</p>';
    document.getElementById('pos-cart-total').textContent = formatMerchPrice(totalCents);
}

function renderMembers(searchTerm = document.getElementById('search-member').value) {
    const term = searchTerm.trim().toLowerCase();
    const matches = members.filter((member) =>
        `${member.name} ${member.custom_id || ''} ${member.role} ${member.tier || ''}`.toLowerCase().includes(term)
    );
    const regularMembers = matches.filter((member) => member.role === 'Member');
    const officers = matches.filter((member) => member.role !== 'Member');
    const uidCell = (member) => currentView === 'admin'
        ? `<td><span class="uid-text" title="${escapeHtml(member.nfc_uid)}">${escapeHtml(member.nfc_uid)}</span></td>`
        : '';
    const memberColumnCount = currentView === 'admin' ? 5 : 4;
    document.getElementById('members-table-body').innerHTML = regularMembers.length ? regularMembers.map((member) => `
        <tr>
            <td><span class="guild-id">${escapeHtml(member.custom_id || '—')}</span></td>
            <td><strong>${escapeHtml(member.name)}</strong></td>
            <td><span class="role-pill">${escapeHtml(member.tier || 'Regular')}</span></td>
            ${uidCell(member)}
            <td class="align-right points-cell">${Number(member.points || 0).toLocaleString()}</td>
        </tr>`).join('') : `<tr><td colspan="${memberColumnCount}" class="empty-cell">${members.some((member) => member.role === 'Member') ? 'No matching members.' : 'No members registered yet.'}</td></tr>`;
    document.getElementById('officers-table-body').innerHTML = officers.length ? officers.map((member) => `
        <tr>
            <td><span class="guild-id">${escapeHtml(member.custom_id || '—')}</span></td>
            <td><strong>${escapeHtml(member.name)}</strong></td>
            <td><span class="role-pill">${escapeHtml(member.role)}</span></td>
            ${uidCell(member)}
            <td class="align-right points-cell">${Number(member.points || 0).toLocaleString()}</td>
        </tr>`).join('') : `<tr><td colspan="${memberColumnCount}" class="empty-cell">${members.some((member) => member.role !== 'Member') ? 'No matching officers.' : 'No officers registered yet.'}</td></tr>`;
}

function renderEvents() {
    renderActivityCalendar();
    const tbody = document.getElementById('events-table-body');
    if (!events.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No events created yet.</td></tr>';
        return;
    }
    tbody.innerHTML = events.map((event) => `
        <tr>
            <td><strong>${escapeHtml(event.name)}</strong></td>
            <td>${escapeHtml(event.event_date)}</td>
            <td><span class="event-points">+${Number(event.points)} pts</span></td>
            <td><span class="event-status${event.closed_at ? ' closed' : ''}">${event.closed_at ? 'Closed' : 'Open'}</span></td>
            <td class="align-right event-actions">${!event.closed_at && ['executive', 'admin'].includes(currentView) ? `<button class="button button-close-event" type="button" data-close-event="${Number(event.id)}">Close</button>` : ''}<button class="button button-delete" type="button" data-delete-event="${Number(event.id)}">Delete</button></td>
        </tr>`).join('');
}

function renderActivityCalendar() {
    const calendar = document.getElementById('activity-calendar');
    const year = activityCalendarDate.getFullYear();
    const month = activityCalendarDate.getMonth();
    document.getElementById('activity-calendar-month').textContent =
        activityCalendarDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const todayString = getGuildDateString();
    const eventsByDate = new Map();
    events.forEach((guildEvent) => {
        const date = String(guildEvent.event_date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
        if (!eventsByDate.has(date)) eventsByDate.set(date, []);
        eventsByDate.get(date).push(guildEvent);
    });
    for (const dayEvents of eventsByDate.values()) {
        dayEvents.sort((left, right) => String(left.name).localeCompare(String(right.name)));
    }

    if (activityCalendarView === 'agenda') {
        const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
        const sortedEvents = events.filter((guildEvent) => String(guildEvent.event_date || '').startsWith(monthPrefix))
            .slice().sort((left, right) => String(left.event_date).localeCompare(String(right.event_date)));
        calendar.innerHTML = sortedEvents.length
            ? `<div class="calendar-agenda-list">${sortedEvents.map((guildEvent) => {
                const date = String(guildEvent.event_date).slice(0, 10);
                return `<article class="calendar-agenda-event${guildEvent.closed_at ? ' closed' : ''}">
                    <time datetime="${escapeHtml(date)}"><span>${escapeHtml(new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' }))}</span><strong>${Number(date.slice(8, 10))}</strong></time>
                    <div class="calendar-agenda-event-copy"><strong>${escapeHtml(guildEvent.name)}</strong><span>${escapeHtml(formatGuildDate(date))} · +${Number(guildEvent.points)} points${guildEvent.closed_at ? ' · Closed' : ''}</span></div>
                </article>`;
            }).join('')}</div>`
            : '<div class="calendar-empty-note">No guild events to show yet.</div>';
        document.getElementById('calendar-agenda').classList.add('hidden');
        return;
    }

    document.getElementById('calendar-agenda').classList.remove('hidden');
    const startDate = new Date(year, month, 1 - firstWeekday);
    const slotCount = Math.ceil((firstWeekday + new Date(year, month + 1, 0).getDate()) / 7) * 7;
    const dayCells = Array.from({ length: slotCount }, (_, index) => {
        const dayDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + index);
        const dateKey = `${dayDate.getFullYear()}-${String(dayDate.getMonth() + 1).padStart(2, '0')}-${String(dayDate.getDate()).padStart(2, '0')}`;
        const isCurrentMonth = dayDate.getMonth() === month;
        const dayEvents = eventsByDate.get(dateKey) || [];
        const dateLabel = dayDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        return `<button class="calendar-day${dateKey === todayString ? ' today' : ''}${dateKey === activityCalendarSelectedDate ? ' selected' : ''}${isCurrentMonth ? '' : ' outside-month'}${dayEvents.length ? ' has-events' : ''}" type="button" data-calendar-date="${dateKey}" aria-pressed="${dateKey === activityCalendarSelectedDate}" aria-label="${escapeHtml(dateLabel)}, ${dayEvents.length} ${dayEvents.length === 1 ? 'event' : 'events'}">
            <span class="calendar-day-number">${dayDate.getDate()}</span>
            <span class="calendar-day-events">${dayEvents.slice(0, 3).map((guildEvent) =>
                `<span class="activity-calendar-event${guildEvent.closed_at ? ' closed' : ''}" title="${escapeHtml(guildEvent.name)}">
                    <span class="calendar-event-name">${escapeHtml(guildEvent.name)}</span><span class="calendar-event-points">+${Number(guildEvent.points)} pts</span>
                </span>`
            ).join('')}${dayEvents.length > 3 ? `<span class="calendar-more-events">+${dayEvents.length - 3} more</span>` : ''}</span>
        </button>`;
    }).join('');
    calendar.innerHTML = `<div class="calendar-weekdays">${weekdays.map((weekday) => `<span>${weekday}</span>`).join('')}</div>
        <div class="calendar-days">${dayCells}</div>`;
    renderCalendarAgenda(eventsByDate.get(activityCalendarSelectedDate) || []);
}

function renderCalendarAgenda(dayEvents) {
    const agenda = document.getElementById('calendar-agenda');
    const selectedDate = new Date(`${activityCalendarSelectedDate}T12:00:00`);
    const dateLabel = selectedDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    agenda.innerHTML = `<div class="calendar-agenda-heading"><p class="eyebrow">DAY SCHEDULE</p><h3>${escapeHtml(dateLabel)}</h3><span>${dayEvents.length} ${dayEvents.length === 1 ? 'event' : 'events'}</span></div>
        ${dayEvents.length ? `<div class="calendar-agenda-list">${dayEvents.map((guildEvent) => `
            <article class="calendar-agenda-event${guildEvent.closed_at ? ' closed' : ''}">
                <span class="calendar-agenda-marker" aria-hidden="true"></span>
                <div class="calendar-agenda-event-copy"><strong>${escapeHtml(guildEvent.name)}</strong><span>+${Number(guildEvent.points)} points${guildEvent.closed_at ? ' · Closed' : ' · Open for check-in'}</span></div>
            </article>`).join('')}</div>` : '<p class="calendar-agenda-empty">Nothing scheduled for this day.</p>'}`;
}

function renderEventOptions() {
    const selected = activeEventSelect.value;
    const availableEvents = events.filter((event) => !event.closed_at).sort((a, b) => b.event_date.localeCompare(a.event_date));
    activeEventSelect.innerHTML = '<option value="">Select an event for check-in</option>' + availableEvents.map((event) =>
        `<option value="${Number(event.id)}">${escapeHtml(event.name)} · +${Number(event.points)} pts · ${escapeHtml(event.event_date)}</option>`
    ).join('');
    if (availableEvents.some((event) => String(event.id) === selected)) activeEventSelect.value = selected;
    nfcInput.disabled = !availableEvents.length || !activeEventSelect.value;
    if (!availableEvents.length) feedback.textContent = 'An officer needs to create an open event before scanning.';
    else if (!activeEventSelect.value) feedback.textContent = 'Select an event to begin scanning.';
}

function renderAttendance() {
    const container = document.getElementById('scan-log-container');
    document.getElementById('scan-count').textContent = attendance.length;
    if (!attendance.length) {
        container.innerHTML = '<div class="empty-state">No check-ins yet.</div>';
        return;
    }
    container.innerHTML = attendance.slice(0, 30).map((log) => {
        const time = parseServerTimestamp(log.timestamp);
        const timeText = time && !Number.isNaN(time.valueOf()) ? time.toLocaleString() : 'Just now';
        const queuedId = String(log.id).startsWith('offline-') ? String(log.id).slice('offline-'.length) : '';
        const offlineActions = log.offlineStatus?.startsWith('Sync failed:')
            ? `<button class="button offline-queue-action" type="button" data-retry-offline="${escapeHtml(queuedId)}">Retry</button><button class="button offline-queue-action" type="button" data-dismiss-offline="${escapeHtml(queuedId)}">Dismiss</button>`
            : '';
        return `<article class="scan-entry">
            <span class="scan-check">✓</span>
            <div class="scan-person"><strong>${escapeHtml(log.member_name || 'Former member')}</strong><small>${escapeHtml(log.custom_id || 'Guild member')}</small></div>
            <div class="scan-award"><strong>${log.offlineStatus ? `${Number(log.points_awarded || 0)} pts pending` : `+${Number(log.points_awarded || 0)} pts`}</strong><small>${escapeHtml(log.event_name)}</small><small>${escapeHtml(timeText)}</small>${log.offlineStatus ? `<small class="offline-checkin-status">${escapeHtml(log.offlineStatus)}</small>${offlineActions}` : ''}</div>
        </article>`;
    }).join('');
}

function renderPointsMemberOptions() {
    const select = document.getElementById('points-member');
    const selected = select.value;
    select.innerHTML = '<option value="">Select a member</option>' + members.map((member) =>
        `<option value="${escapeHtml(member.custom_id || '')}">${escapeHtml(member.name)} · ${escapeHtml(member.custom_id || 'No guild ID')} · ${Number(member.points || 0)} pts</option>`
    ).join('');
    if (members.some((member) => member.custom_id === selected)) select.value = selected;
}

function renderPointHistory() {
    const tbody = document.getElementById('points-history-body');
    if (!pointAdjustments.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">No manual adjustments yet.</td></tr>';
        return;
    }
    tbody.innerHTML = pointAdjustments.map((adjustment) => {
        const date = parseServerTimestamp(adjustment.created_at);
        const dateText = Number.isNaN(date.valueOf()) ? adjustment.created_at : date.toLocaleString();
        const delta = Number(adjustment.delta);
        return `<tr>
            <td><strong>${escapeHtml(adjustment.member_name)}</strong><small class="table-subtext">${escapeHtml(adjustment.custom_id || '')}</small></td>
            <td class="${delta > 0 ? 'adjustment-add' : 'adjustment-deduct'}">${delta > 0 ? '+' : ''}${delta} pts</td>
            <td class="reason-cell">${escapeHtml(adjustment.reason)}</td>
            <td><span class="table-subtext">${escapeHtml(dateText)}</span><small class="table-subtext">${escapeHtml(adjustment.actor_role)}</small></td>
        </tr>`;
    }).join('');
}

function openTab(tabId) {
    const staffTab = ['tab-members', 'tab-events', 'tab-points', 'tab-tasks', 'tab-projects'].includes(tabId);
    if (staffTab && currentView === 'member') return;
    if (tabId === 'tab-admin' && currentView !== 'admin') return;
    if (tabId === 'tab-attendance' && !['officer', 'executive', 'admin'].includes(currentView)) return;
    if (tabId === 'tab-profile' && !authenticatedStaff) return;

    document.querySelectorAll('.tab-content').forEach((tab) => {
        const selected = tab.id === tabId;
        tab.classList.toggle('hidden', !selected);
        tab.setAttribute('aria-hidden', String(!selected));
    });
    document.querySelectorAll('.nav-item').forEach((item) => {
        const selected = item.dataset.target === tabId;
        item.classList.toggle('active', selected);
        item.setAttribute('aria-selected', String(selected));
        item.tabIndex = selected ? 0 : -1;
    });
    const titles = {
        'tab-dashboard': 'Guild overview',
        'tab-attendance': 'NFC check-in',
        'tab-profile': 'My guild profile',
        'tab-calendar': 'Guild activity calendar',
        'tab-merch': 'Guild merch store',
        'tab-members': 'Member database',
        'tab-events': 'Event management',
        'tab-points': 'Points adjustment',
        'tab-announcements': 'Guild announcements',
        'tab-tasks': 'Event task tracker',
        'tab-projects': 'Project boards',
        'tab-admin': 'Admin workspace'
    };
    document.getElementById('page-title').textContent = titles[tabId] || 'NCGG dashboard';
    if (tabId === 'tab-profile' && authenticatedStaff) {
        void loadProfile().catch((error) => showToast(error.message, true));
    }
    if (tabId === 'tab-tasks' && currentView !== 'member') {
        void loadProjectWorkspaceOptions().then(loadEventTasks).catch((error) => showToast(error.message, true));
    }
    if (tabId === 'tab-projects' && currentView !== 'member') {
        void loadProjectWorkspaces(document.getElementById('project-workspace-select').value)
            .catch((error) => showToast(error.message, true));
    }
    if (tabId === 'tab-attendance' && activeEventSelect.value) window.setTimeout(() => nfcInput.focus(), 80);
}

function setView(role) {
    if (currentView === 'admin' && role !== 'admin') {
        members = members.map(({ nfc_uid, ...member }) => member);
    }
    currentView = role;
    const isOfficer = ['officer', 'executive', 'admin'].includes(role);
    document.querySelectorAll('.staff-only').forEach((element) => element.classList.toggle('hidden', !isOfficer));
    document.querySelectorAll('.executive-only').forEach((element) => element.classList.toggle('hidden', !['executive', 'admin'].includes(role)));
    document.querySelectorAll('.admin-only').forEach((element) => element.classList.toggle('hidden', role !== 'admin'));
    document.querySelectorAll('.task-staff-only').forEach((element) => element.classList.toggle('hidden', !isOfficer));
    document.querySelectorAll('.signed-in-only').forEach((element) => element.classList.toggle('hidden', !authenticatedStaff));
    document.getElementById('profile-quest-panel').classList.toggle('hidden', !authenticatedStaff);
    document.getElementById('merch-admin-panel').classList.toggle('hidden', role !== 'admin');
    document.querySelectorAll('.announcement-publisher').forEach((element) =>
        element.classList.toggle('hidden', !['officer', 'executive', 'admin'].includes(role))
    );
    document.querySelectorAll('#member-role option').forEach((option) => {
        option.disabled = isOfficer && !['executive', 'admin'].includes(role) && option.value !== 'Member';
    });
    renderMembers();
    document.getElementById('display-role').textContent = role.charAt(0).toUpperCase() + role.slice(1);
    document.getElementById('user-avatar').textContent = role.charAt(0).toUpperCase();
    document.getElementById('btn-logout').textContent = authenticatedStaff ? 'Sign out' : 'Guild sign in';
    loginOverlay.classList.add('hidden');
    openTab(authenticatedStaff ? 'tab-profile' : 'tab-dashboard');
}

document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorLabel = document.getElementById('login-error');
    errorLabel.classList.add('hidden');
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
        const result = await api('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({
                guild_id: document.getElementById('login-guild-id').value,
                password: document.getElementById('login-password').value
            })
        });
        clearPrivateProfileData();
        authenticatedStaff = result.staff;
        document.getElementById('login-password').value = '';
        setView(authenticatedStaff.role);
        await refreshData();
        showToast(`Signed in as ${authenticatedStaff.name}.`);
    } catch (error) {
        errorLabel.textContent = error.message;
        errorLabel.classList.remove('hidden');
    } finally {
        submit.disabled = false;
    }
});
document.getElementById('project-create-quest').addEventListener('click', async () => {
    try {
        await loadProjectWorkspaceOptions();
        document.getElementById('task-workspace-create').value = String(projectBoard.workspace_id);
        openTab('tab-tasks');
        document.getElementById('task-create-panel').open = true;
        document.getElementById('task-title').focus();
    } catch (error) {
        showToast(error.message, true);
    }
});

document.getElementById('btn-member-view').addEventListener('click', () => {
    clearPrivateProfileData();
    authenticatedStaff = null;
    setView('member');
});
document.getElementById('btn-logout').addEventListener('click', async () => {
    if (authenticatedStaff) {
        try {
            await api('/api/auth/logout', { method: 'POST' });
        } catch (error) {
            showToast(error.message, true);
        }
        clearPrivateProfileData();
        authenticatedStaff = null;
        setView('member');
        await refreshData();
        showToast('Signed out.');
        return;
    }
    clearPrivateProfileData();
    authenticatedStaff = null;
    document.getElementById('login-error').classList.add('hidden');
    loginOverlay.classList.remove('hidden');
    document.getElementById('login-guild-id').focus();
});

const navigation = document.querySelector('.navigation');
const mobileNavigation = window.matchMedia('(max-width: 640px)');
const syncNavigationOrientation = () => navigation.setAttribute('aria-orientation', mobileNavigation.matches ? 'horizontal' : 'vertical');
syncNavigationOrientation();
mobileNavigation.addEventListener('change', syncNavigationOrientation);

navigation.addEventListener('click', (event) => {
    const button = event.target.closest('.nav-item');
    if (button) openTab(button.dataset.target);
});
navigation.addEventListener('keydown', (event) => {
    const tabs = Array.from(navigation.querySelectorAll('.nav-item:not(.hidden)'));
    const currentIndex = tabs.indexOf(event.target.closest('.nav-item'));
    if (currentIndex < 0) return;
    let nextIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    openTab(nextTab.dataset.target);
    nextTab.focus();
});
document.querySelectorAll('[data-open-tab]').forEach((button) => button.addEventListener('click', () => {
    const tabId = button.dataset.openTab;
    openTab(tabId);
    document.getElementById(tabId).focus();
}));

document.getElementById('form-add-member').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
        name: document.getElementById('member-name').value.trim(),
        custom_id: document.getElementById('member-custom-id').value.trim().toUpperCase(),
        role: document.getElementById('member-role').value,
        tier: document.getElementById('member-tier').value,
        nfc_uid: document.getElementById('member-nfc-id').value.trim()
    };
    try {
        await api('/api/members', { method: 'POST', body: JSON.stringify(payload) });
        event.target.reset();
        updateMemberTierVisibility();
        await refreshData();
        showToast(`${payload.name} added to the guild roster.`);
        document.getElementById('member-name').focus();
    } catch (error) {
        showToast(error.message, true);
    }
});

function updateMemberTierVisibility(role = document.getElementById('member-role').value) {
    document.getElementById('member-tier-field').classList.toggle('hidden', role !== 'Member');
}

document.getElementById('member-role').addEventListener('change', (event) => updateMemberTierVisibility(event.target.value));

document.getElementById('form-staff-password').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
        guild_id: document.getElementById('staff-password-guild-id').value,
        password: document.getElementById('staff-password-value').value
    };
    try {
        await api('/api/staff/password', { method: 'POST', body: JSON.stringify(payload) });
        event.target.reset();
        showToast('Account password saved. Share it securely with the account holder.');
    } catch (error) {
        showToast(error.message, true);
    }
});

document.getElementById('form-create-event').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
        name: document.getElementById('event-name').value.trim(),
        event_date: document.getElementById('event-date').value,
        points: Number(document.getElementById('event-points').value)
    };
    try {
        await api('/api/events', { method: 'POST', body: JSON.stringify(payload) });
        event.target.reset();
        document.getElementById('event-date').value = getGuildDateString();
        document.getElementById('event-points').value = '10';
        await refreshData();
        showToast('Event published. It is now available for check-in.');
    } catch (error) {
        showToast(error.message, true);
    }
});

document.getElementById('form-merch').addEventListener('submit', async (event) => {
    event.preventDefault();
    const itemId = document.getElementById('merch-item-id').value;
    const payload = {
        name: document.getElementById('merch-name').value.trim(),
        description: document.getElementById('merch-description').value.trim(),
        price_cents: Math.round(Number(document.getElementById('merch-price').value) * 100),
        inventory: Number(document.getElementById('merch-inventory').value)
    };
    try {
        const imageFile = document.getElementById('merch-image').files[0];
        if (imageFile) {
            if (imageFile.size > 5 * 1024 * 1024) {
                showToast('Product images must be no larger than 5 MB.', true);
                return;
            }
            payload.image_type = imageFile.type;
            payload.image_filename = imageFile.name;
            payload.image_data = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = () => reject(new Error('Could not read the selected product image.'));
                reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
                reader.readAsDataURL(imageFile);
            });
        }
        payload.remove_image = document.getElementById('merch-remove-image').checked;
        await api(itemId ? `/api/merch/${itemId}` : '/api/merch', {
            method: itemId ? 'PATCH' : 'POST',
            body: JSON.stringify(payload)
        });
        event.target.reset();
        document.getElementById('merch-item-id').value = '';
        document.getElementById('merch-cancel-edit').classList.add('hidden');
        document.getElementById('merch-remove-image-wrap').classList.add('hidden');
        document.getElementById('merch-image-preview').classList.add('hidden');
        document.getElementById('merch-admin-panel').open = false;
        if (!itemId) {
            document.getElementById('merch-search').value = '';
            document.getElementById('merch-stock-filter').value = 'all';
        }
        await loadMerch();
        showToast(itemId ? 'Merchandise item updated.' : 'Merchandise item added.');
    } catch (error) {
        showToast(error.message, true);
    }
});

document.getElementById('merch-cancel-edit').addEventListener('click', () => {
    document.getElementById('form-merch').reset();
    document.getElementById('merch-item-id').value = '';
    document.getElementById('merch-cancel-edit').classList.add('hidden');
    document.getElementById('merch-remove-image-wrap').classList.add('hidden');
    document.getElementById('merch-image-preview').classList.add('hidden');
    document.getElementById('merch-admin-panel').open = false;
});

document.getElementById('merch-add-product-button').addEventListener('click', () => {
    document.getElementById('form-merch').reset();
    document.getElementById('merch-item-id').value = '';
    document.getElementById('merch-cancel-edit').classList.add('hidden');
    document.getElementById('merch-remove-image-wrap').classList.add('hidden');
    document.getElementById('merch-image-preview').classList.add('hidden');
    const panel = document.getElementById('merch-admin-panel');
    panel.open = true;
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('merch-name').focus({ preventScroll: true });
});
document.querySelectorAll('[data-open-product-form]').forEach((button) => {
    button.addEventListener('click', () => {
        openTab('tab-merch');
        document.getElementById('merch-add-product-button').click();
    });
});

document.getElementById('merch-image').addEventListener('change', (event) => {
    const file = event.target.files[0];
    const preview = document.getElementById('merch-image-preview');
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
        event.target.value = '';
        preview.classList.add('hidden');
        showToast('Choose a JPEG, PNG, or WebP image no larger than 5 MB.', true);
        return;
    }
    preview.src = URL.createObjectURL(file);
    preview.classList.remove('hidden');
});

document.getElementById('merch-search').addEventListener('input', () => renderMerch());
document.getElementById('merch-stock-filter').addEventListener('change', () => renderMerch());
document.getElementById('pos-clear-cart').addEventListener('click', () => {
    merchCart.clear();
    renderMerch();
});

document.getElementById('pos-cart-items').addEventListener('click', (event) => {
    const changeButton = event.target.closest('[data-cart-change]');
    const removeButton = event.target.closest('[data-cart-remove]');
    if (removeButton) {
        merchCart.delete(Number(removeButton.dataset.cartRemove));
        renderMerch();
        return;
    }
    if (!changeButton) return;
    const itemId = Number(changeButton.dataset.cartChange);
    const item = merchItems.find((row) => Number(row.id) === itemId);
    if (!item) {
        merchCart.delete(itemId);
        renderMerch();
        return;
    }
    const nextQuantity = (merchCart.get(itemId) || 0) + Number(changeButton.dataset.quantityDelta);
    if (nextQuantity < 1) merchCart.delete(itemId);
    else merchCart.set(itemId, Math.min(nextQuantity, Number(item.inventory)));
    renderMerch();
});

document.getElementById('merch-list').addEventListener('click', async (event) => {
    const addButton = event.target.closest('[data-add-to-cart]');
    const editButton = event.target.closest('[data-edit-merch]');
    const deleteButton = event.target.closest('[data-delete-merch]');
    if (addButton) {
        const item = merchItems.find((row) => Number(row.id) === Number(addButton.dataset.addToCart));
        if (!item || Number(item.inventory) < 1) return;
        const currentQuantity = merchCart.get(Number(item.id)) || 0;
        if (currentQuantity >= Number(item.inventory)) {
            showToast('The order preview cannot exceed the available stock.', true);
            return;
        }
        merchCart.set(Number(item.id), currentQuantity + 1);
        renderMerch();
    } else if (editButton) {
        const item = merchItems.find((row) => Number(row.id) === Number(editButton.dataset.editMerch));
        if (!item) return;
        document.getElementById('merch-item-id').value = item.id;
        document.getElementById('merch-name').value = item.name;
        document.getElementById('merch-description').value = item.description || '';
        document.getElementById('merch-price').value = (Number(item.price_cents) / 100).toFixed(2);
        document.getElementById('merch-inventory').value = item.inventory;
        document.getElementById('merch-cancel-edit').classList.remove('hidden');
        document.getElementById('merch-admin-panel').open = true;
        document.getElementById('merch-remove-image-wrap').classList.toggle('hidden', !item.image_type);
        document.getElementById('merch-remove-image').checked = false;
        const preview = document.getElementById('merch-image-preview');
        if (item.image_type) {
            preview.src = `/api/merch/${Number(item.id)}/image`;
            preview.classList.remove('hidden');
        } else {
            preview.classList.add('hidden');
        }
        document.getElementById('merch-admin-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
        document.getElementById('merch-name').focus();
    } else if (deleteButton) {
        if (!window.confirm('Remove this merchandise item from the store?')) return;
        try {
            await api(`/api/merch/${deleteButton.dataset.deleteMerch}`, { method: 'DELETE' });
            await loadMerch();
            showToast('Merchandise item removed.');
        } catch (error) {
            showToast(error.message, true);
        }
    }
});

document.getElementById('form-adjust-points').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!['officer', 'executive', 'admin'].includes(currentView)) {
        showToast('Only officers, executives, and the administrator can adjust points.', true);
        return;
    }

    const memberGuildId = document.getElementById('points-member').value;
    const amount = Number(document.getElementById('points-amount').value);
    const direction = document.getElementById('points-direction').value;
    const reason = document.getElementById('points-reason').value.trim();
    const member = members.find((item) => item.custom_id === memberGuildId);
    if (!member) {
        showToast('Select a registered member first.', true);
        return;
    }
    if (direction === 'deduct' && !window.confirm(`Deduct ${amount} points from ${member.name}?`)) return;

    try {
        const result = await api('/api/points/adjust', {
            method: 'POST',
            body: JSON.stringify({ guild_id: memberGuildId, amount, direction, reason })
        });
        event.target.reset();
        await refreshData();
        const verb = result.delta > 0 ? 'added to' : 'deducted from';
        showToast(`${Math.abs(result.delta)} points ${verb} ${result.member}. New balance: ${result.newPoints}.`);
    } catch (error) {
        showToast(error.message, true);
    }
});

document.getElementById('events-table-body').addEventListener('click', async (event) => {
    const closeButton = event.target.closest('[data-close-event]');
    if (closeButton) {
        if (!['executive', 'admin'].includes(currentView)) {
            showToast('Only executives and the administrator can close events.', true);
            return;
        }
        if (!window.confirm('Close this event? It will no longer accept check-ins.')) return;
        try {
            await api(`/api/events/${closeButton.dataset.closeEvent}/close`, {
                method: 'POST'
            });
            await refreshData();
            showToast('Event closed. Check-ins are no longer available.');
        } catch (error) {
            showToast(error.message, true);
        }
        return;
    }
    const button = event.target.closest('[data-delete-event]');
    if (!button) return;
    try {
        await api(`/api/events/${button.dataset.deleteEvent}`, { method: 'DELETE' });
        await refreshData();
        showToast('Event deleted.');
    } catch (error) {
        showToast(error.message, true);
    }
});

document.getElementById('form-announcement').addEventListener('submit', async (event) => {
    event.preventDefault();
    const mediaFile = document.getElementById('announcement-media').files[0];
    if (mediaFile && mediaFile.size > 5 * 1024 * 1024) {
        showToast('Announcement media must be no larger than 5 MB.', true);
        return;
    }
    const payload = {
        title: document.getElementById('announcement-title').value.trim(),
        body: document.getElementById('announcement-body').value.trim()
    };
    try {
        if (mediaFile) {
            payload.media_type = mediaFile.type;
            payload.media_filename = mediaFile.name;
            payload.media_data = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = () => reject(new Error('Could not read the selected announcement media.'));
                reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
                reader.readAsDataURL(mediaFile);
            });
        }
        await api('/api/announcements', { method: 'POST', body: JSON.stringify(payload) });
        event.target.reset();
        announcements = await loadAnnouncements();
        renderAnnouncements();
        showToast('Announcement published.');
    } catch (error) {
        showToast(error.message, true);
    }
});

document.getElementById('announcements-list').addEventListener('click', async (event) => {
    const pickerButton = event.target.closest('[data-reaction-picker]');
    if (pickerButton) {
        const announcementId = Number(pickerButton.dataset.reactionPicker);
        if (openAnnouncementReactionPickers.has(announcementId)) openAnnouncementReactionPickers.delete(announcementId);
        else openAnnouncementReactionPickers.add(announcementId);
        renderAnnouncements();
        return;
    }
    const button = event.target.closest('[data-announcement-reaction]');
    const customButton = event.target.closest('[data-custom-reaction]');
    if (!button && !customButton) return;
    const announcementId = Number(button?.dataset.announcementReaction || customButton?.dataset.customReaction);
    const customInput = customButton
        ? document.querySelector(`[data-custom-reaction-input="${announcementId}"]`)
        : null;
    const reaction = button?.dataset.reaction || customInput?.value.trim() || '';
    if (!isEmojiReaction(reaction)) {
        showToast('Enter one emoji to react.', true);
        return;
    }
    if (pendingAnnouncementReactions.has(announcementId)) return;
    const announcement = announcements.find((item) => Number(item.id) === announcementId);
    if (!announcement) return;

    const previousReaction = announcement.user_reaction || '';
    const nextReaction = previousReaction === reaction ? '' : reaction;
    const previousCounts = { ...(announcement.reaction_counts || {}) };
    const nextCounts = { ...previousCounts };
    if (previousReaction) nextCounts[previousReaction] = Math.max(0, Number(nextCounts[previousReaction] || 0) - 1);
    if (nextReaction) nextCounts[nextReaction] = Number(nextCounts[nextReaction] || 0) + 1;
    announcement.reaction_counts = nextCounts;
    announcement.user_reaction = nextReaction;
    pendingAnnouncementReactions.add(announcementId);
    if (customButton) openAnnouncementReactionPickers.delete(announcementId);
    renderAnnouncements();

    try {
        const result = await api(`/api/announcements/${announcementId}/reactions`, {
            method: 'POST',
            body: JSON.stringify({
                reactor_id: getAnnouncementReactorId(),
                reaction
            })
        });
        const currentAnnouncement = announcements.find((item) => Number(item.id) === announcementId);
        if (currentAnnouncement && result.reaction !== currentAnnouncement.user_reaction) {
            const counts = { ...(currentAnnouncement.reaction_counts || {}) };
            const currentReaction = currentAnnouncement.user_reaction || '';
            if (currentReaction) counts[currentReaction] = Math.max(0, Number(counts[currentReaction] || 0) - 1);
            if (result.reaction) counts[result.reaction] = Number(counts[result.reaction] || 0) + 1;
            currentAnnouncement.reaction_counts = counts;
            currentAnnouncement.user_reaction = result.reaction;
        }
    } catch (error) {
        const currentAnnouncement = announcements.find((item) => Number(item.id) === announcementId);
        if (currentAnnouncement) {
            currentAnnouncement.reaction_counts = previousCounts;
            currentAnnouncement.user_reaction = previousReaction;
        }
        showToast(error.message, true);
    } finally {
        pendingAnnouncementReactions.delete(announcementId);
        renderAnnouncements();
    }
});

document.getElementById('announcement-search').addEventListener('input', () => renderAnnouncements());
document.getElementById('announcement-role-filter').addEventListener('change', () => renderAnnouncements());
document.getElementById('announcement-date-from').addEventListener('change', () => renderAnnouncements());
document.getElementById('announcement-date-to').addEventListener('change', () => renderAnnouncements());
document.getElementById('announcement-sort').addEventListener('change', () => renderAnnouncements());
document.getElementById('announcement-clear-filters').addEventListener('click', () => {
    document.getElementById('announcement-search').value = '';
    document.getElementById('announcement-role-filter').value = '';
    document.getElementById('announcement-date-from').value = '';
    document.getElementById('announcement-date-to').value = '';
    document.getElementById('announcement-sort').value = 'newest';
    renderAnnouncements();
});

document.getElementById('form-create-task').addEventListener('submit', async (event) => {
    event.preventDefault();
    const eventValue = document.getElementById('task-event-create').value;
    const workspaceValue = document.getElementById('task-workspace-create').value;
    const payload = {
        event_id: eventValue ? Number(eventValue) : null,
        workspace_id: workspaceValue ? Number(workspaceValue) : null,
        committee: document.getElementById('task-committee').value.trim(),
        title: document.getElementById('task-title').value.trim(),
        priority: document.getElementById('task-priority').value,
        points_reward: Number(document.getElementById('task-points-reward').value),
        status: document.getElementById('task-status').value,
        assignees: Array.from(document.getElementById('task-assignees').selectedOptions, (option) => option.value),
        deadline: document.getElementById('task-deadline').value,
        description: document.getElementById('task-description').value.trim(),
        link_url: document.getElementById('task-link').value.trim(),
        progress: 0
    };
    try {
        await api('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
        document.getElementById('task-title').value = '';
        document.getElementById('task-description').value = '';
        document.getElementById('task-link').value = '';
        document.getElementById('task-points-reward').value = '1';
        document.getElementById('task-assignees').selectedIndex = -1;
        document.getElementById('task-status').value = 'Not started';
        document.getElementById('task-event-select').value = eventValue;
        renderTaskEventOptions();
        await loadEventTasks();
        showToast('Quest added.');
    } catch (error) {
        showToast(error.message, true);
    }
});

document.getElementById('task-event-select').addEventListener('change', () => {
    renderTaskEventOptions();
    void loadEventTasks();
});

document.getElementById('profile-task-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-task-submission]');
    if (!button) return;
    button.disabled = true;
    try {
        const submitted = button.dataset.submitted !== 'true';
        const result = await api(`/api/profile/tasks/${button.dataset.taskSubmission}/submission`, {
            method: 'POST',
            body: JSON.stringify({ submitted })
        });
        await loadProfile();
        showToast(submitted
            ? `Quest submitted. You earned ${result.points_delta} point${result.points_delta === 1 ? '' : 's'}.`
            : `Submission undone. ${Math.abs(result.points_delta)} point${Math.abs(result.points_delta) === 1 ? '' : 's'} deducted.`);
    } catch (error) {
        button.disabled = false;
        showToast(error.message, true);
    }
});

document.querySelectorAll('[data-task-view]').forEach((button) => {
    button.addEventListener('click', () => setTaskView(button.dataset.taskView));
});
document.getElementById('calendar-previous').addEventListener('click', () => {
    taskCalendarDate = new Date(taskCalendarDate.getFullYear(), taskCalendarDate.getMonth() - 1, 1);
    renderTaskCalendar();
});
document.getElementById('calendar-next').addEventListener('click', () => {
    taskCalendarDate = new Date(taskCalendarDate.getFullYear(), taskCalendarDate.getMonth() + 1, 1);
    renderTaskCalendar();
});
document.getElementById('calendar-today').addEventListener('click', () => {
    taskCalendarDate = getGuildCalendarStart();
    renderTaskCalendar();
});
document.getElementById('activity-calendar-previous').addEventListener('click', () => {
    activityCalendarDate = new Date(activityCalendarDate.getFullYear(), activityCalendarDate.getMonth() - 1, 1);
    activityCalendarSelectedDate = `${activityCalendarDate.getFullYear()}-${String(activityCalendarDate.getMonth() + 1).padStart(2, '0')}-01`;
    renderActivityCalendar();
});
document.getElementById('activity-calendar-next').addEventListener('click', () => {
    activityCalendarDate = new Date(activityCalendarDate.getFullYear(), activityCalendarDate.getMonth() + 1, 1);
    activityCalendarSelectedDate = `${activityCalendarDate.getFullYear()}-${String(activityCalendarDate.getMonth() + 1).padStart(2, '0')}-01`;
    renderActivityCalendar();
});
document.getElementById('activity-calendar-today').addEventListener('click', () => {
    activityCalendarDate = getGuildCalendarStart();
    activityCalendarSelectedDate = getGuildDateString();
    renderActivityCalendar();
});
document.querySelectorAll('[data-activity-view]').forEach((button) => {
    button.addEventListener('click', () => {
        activityCalendarView = button.dataset.activityView;
        document.querySelectorAll('[data-activity-view]').forEach((viewButton) => {
            const selected = viewButton.dataset.activityView === activityCalendarView;
            viewButton.classList.toggle('active', selected);
            viewButton.setAttribute('aria-pressed', String(selected));
        });
        renderActivityCalendar();
    });
});
document.getElementById('activity-calendar').addEventListener('click', (event) => {
    const dayButton = event.target.closest('[data-calendar-date]');
    if (!dayButton) return;
    activityCalendarSelectedDate = dayButton.dataset.calendarDate;
    const [year, month] = activityCalendarSelectedDate.split('-').map(Number);
    if (year !== activityCalendarDate.getFullYear() || month !== activityCalendarDate.getMonth() + 1) {
        activityCalendarDate = new Date(year, month - 1, 1);
    }
    renderActivityCalendar();
});
document.getElementById('task-calendar').addEventListener('click', (event) => {
    const taskButton = event.target.closest('[data-calendar-task]');
    if (!taskButton) return;
    setTaskView('board');
    const row = document.getElementById(`task-row-${taskButton.dataset.calendarTask}`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.querySelector('.task-details')?.setAttribute('open', '');
});

const eventTaskList = document.getElementById('event-task-list');
document.getElementById('project-new-workspace').addEventListener('click', () => {
    document.getElementById('project-create-workspace-form').classList.remove('hidden');
    document.getElementById('project-workspace-name-input').focus();
});
document.getElementById('project-new-board').addEventListener('click', () => {
    document.getElementById('project-create-board-form').classList.remove('hidden');
    document.getElementById('project-board-name-input').focus();
});
document.getElementById('project-new-group').addEventListener('click', () => {
    const form = document.getElementById('project-create-group-form');
    form.classList.remove('hidden');
    document.getElementById('project-group-name-input').focus();
});
document.querySelectorAll('[data-create-workspace]').forEach((button) => {
    button.addEventListener('click', () => document.getElementById('project-new-workspace').click());
});
document.querySelectorAll('[data-create-board]').forEach((button) => {
    button.addEventListener('click', () => document.getElementById('project-new-board').click());
});
document.querySelectorAll('[data-cancel-project-form]').forEach((button) => {
    button.addEventListener('click', () => {
        const form = button.closest('form');
        form.reset();
        form.classList.add('hidden');
    });
});
document.getElementById('project-workspace-select').addEventListener('change', async (event) => {
    try {
        await loadProjectBoards(event.target.value);
    } catch (error) {
        showToast(error.message, true);
    }
});
document.getElementById('project-board-select').addEventListener('change', async (event) => {
    try {
        await loadProjectBoard(event.target.value);
    } catch (error) {
        showToast(error.message, true);
    }
});
document.getElementById('project-create-workspace-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
        const result = await api('/api/project-workspaces', {
            method: 'POST',
            body: JSON.stringify({ name: document.getElementById('project-workspace-name-input').value.trim() })
        });
        event.target.reset();
        event.target.classList.add('hidden');
        await loadProjectWorkspaces(result.id);
        showToast('Workspace created.');
    } catch (error) {
        showToast(error.message, true);
    }
});
document.getElementById('project-create-board-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const workspaceId = document.getElementById('project-workspace-select').value;
    try {
        const result = await api(`/api/project-workspaces/${encodeURIComponent(workspaceId)}/boards`, {
            method: 'POST',
            body: JSON.stringify({ name: document.getElementById('project-board-name-input').value.trim() })
        });
        event.target.reset();
        event.target.classList.add('hidden');
        await loadProjectBoards(workspaceId, result.id);
        showToast('Board created with a starter group.');
    } catch (error) {
        showToast(error.message, true);
    }
});
document.getElementById('project-create-group-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!projectBoard) return;
    try {
        await api(`/api/project-boards/${projectBoard.id}/groups`, {
            method: 'POST',
            body: JSON.stringify({ name: document.getElementById('project-group-name-input').value.trim() })
        });
        event.target.reset();
        event.target.classList.add('hidden');
        await loadProjectBoard(projectBoard.id);
        showToast('Group added.');
    } catch (error) {
        showToast(error.message, true);
    }
});
document.getElementById('project-group-list').addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-project-add-item]');
    if (!form) return;
    event.preventDefault();
    try {
        await api(`/api/project-groups/${form.dataset.projectAddItem}/items`, {
            method: 'POST',
            body: JSON.stringify({ title: form.elements.title.value.trim() })
        });
        await loadProjectBoard(projectBoard.id);
        showToast('Item added.');
    } catch (error) {
        showToast(error.message, true);
    }
});
document.getElementById('project-group-list').addEventListener('change', async (event) => {
    const field = event.target.closest('[data-project-field]');
    if (!field) return;
    const row = field.closest('[data-project-item]');
    const value = field.value;
    try {
        await api(`/api/project-items/${row.dataset.projectItem}`, {
            method: 'PATCH',
            body: JSON.stringify({ [field.dataset.projectField]: value })
        });
        if (field.dataset.projectField === 'status') {
            field.className = `field project-status status-${value.toLowerCase().replace(/\s+/g, '-')}`;
        }
        showToast('Item updated.');
    } catch (error) {
        showToast(error.message, true);
        await loadProjectBoard(projectBoard.id);
    }
});

eventTaskList.addEventListener('change', (event) => {
    if (event.target.matches('.task-priority-select')) {
        event.target.classList.remove('priority-low', 'priority-medium', 'priority-high');
        event.target.classList.add(`priority-${event.target.value.toLowerCase()}`);
        return;
    }
    if (event.target.matches('.task-status-select')) {
        event.target.classList.remove('status-not-started', 'status-open', 'status-complete');
        event.target.classList.add(`status-${event.target.value.toLowerCase().replace(/\s+/g, '-')}`);
        return;
    }
    const subtaskToggle = event.target.closest('[data-subtask-toggle]');
    if (subtaskToggle) {
        void (async () => {
            try {
                await api(`/api/tasks/${subtaskToggle.dataset.taskId}/subtasks/${subtaskToggle.dataset.subtaskToggle}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ completed: subtaskToggle.checked })
                });
                await loadEventTasks();
            } catch (error) {
                showToast(error.message, true);
                await loadEventTasks();
            }
        })();
    }
});

eventTaskList.addEventListener('submit', async (event) => {
    const updateForm = event.target.closest('[data-task-update]');
    const editForm = event.target.closest('[data-task-edit]');
    const commentForm = event.target.closest('[data-task-comment]');
    const attachmentForm = event.target.closest('[data-task-attachment]');
    const subtaskForm = event.target.closest('[data-task-subtask]');
    if (!updateForm && !editForm && !commentForm && !attachmentForm && !subtaskForm) return;
    event.preventDefault();
    try {
        if (updateForm) {
            await api(`/api/tasks/${updateForm.dataset.taskUpdate}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    status: updateForm.elements.status.value,
                    priority: updateForm.elements.priority.value,
                    deadline: updateForm.elements.deadline.value,
                    assignees: Array.from(updateForm.elements.assignees.selectedOptions, (option) => option.value)
                })
            });
            showToast('Task updated.');
        } else if (editForm) {
            await api(`/api/tasks/${editForm.dataset.taskEdit}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    title: editForm.elements.title.value.trim(),
                    committee: editForm.elements.committee.value.trim(),
                    description: editForm.elements.description.value.trim(),
                    link_url: editForm.elements.link_url.value.trim(),
                    workspace_id: editForm.elements.workspace_id.value ? Number(editForm.elements.workspace_id.value) : null,
                    points_reward: Number(editForm.elements.points_reward.value)
                })
            });
            showToast('Task details saved.');
        } else if (commentForm) {
            await api(`/api/tasks/${commentForm.dataset.taskComment}/comments`, {
                method: 'POST',
                body: JSON.stringify({ body: commentForm.elements.body.value.trim() })
            });
            showToast('Comment added.');
        } else if (subtaskForm) {
            await api(`/api/tasks/${subtaskForm.dataset.taskSubtask}/subtasks`, {
                method: 'POST',
                body: JSON.stringify({ title: subtaskForm.elements.title.value.trim() })
            });
            showToast('Subtask added.');
        } else {
            const files = Array.from(attachmentForm.elements.files.files);
            if (!files.length) return;
            const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
            for (const file of files) {
                if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} is larger than 5 MB.`);
                if (!allowedTypes.includes(file.type)) throw new Error(`${file.name}: only PDF, JPEG, PNG, GIF, and WebP files are supported.`);
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}.`));
                    reader.readAsDataURL(file);
                });
                await api(`/api/tasks/${attachmentForm.dataset.taskAttachment}/attachments`, {
                    method: 'POST',
                    body: JSON.stringify({
                        filename: file.name,
                        mime_type: file.type,
                        content_base64: String(dataUrl).split(',')[1]
                    })
                });
            }
            showToast(`${files.length} file${files.length === 1 ? '' : 's'} uploaded.`);
        }
        await loadEventTasks();
    } catch (error) {
        showToast(error.message, true);
    }
});

eventTaskList.addEventListener('click', async (event) => {
    const deleteTask = event.target.closest('[data-delete-task]');
    const deleteSubtask = event.target.closest('[data-delete-subtask]');
    if (!deleteTask && !deleteSubtask) return;
    const message = deleteTask ? 'Delete this task and all its comments, attachments, and subtasks?' : 'Delete this subtask?';
    if (!window.confirm(message)) return;
    try {
        if (deleteTask) {
            await api(`/api/tasks/${deleteTask.dataset.deleteTask}`, { method: 'DELETE' });
            showToast('Task deleted.');
        } else {
            await api(`/api/tasks/${deleteSubtask.dataset.taskId}/subtasks/${deleteSubtask.dataset.deleteSubtask}`, { method: 'DELETE' });
            showToast('Subtask deleted.');
        }
        await loadEventTasks();
    } catch (error) {
        showToast(error.message, true);
    }
});

['task-search', 'task-filter-status', 'task-filter-priority', 'task-filter-assignee'].forEach((id) => {
    document.getElementById(id).addEventListener(id === 'task-search' ? 'input' : 'change', () => renderEventTasks());
});

document.getElementById('search-member').addEventListener('input', (event) => renderMembers(event.target.value));
activeEventSelect.addEventListener('change', () => {
    nfcInput.disabled = !activeEventSelect.value;
    feedback.textContent = activeEventSelect.value ? 'Ready. Tap a registered member card.' : 'Select an event to begin scanning.';
    if (activeEventSelect.value && !document.getElementById('tab-attendance').classList.contains('hidden')) nfcInput.focus();
});

// Some keyboard-wedge reader configurations do not append Enter after the UID.
nfcInput.addEventListener('input', () => {
    window.clearTimeout(scanTimer);
    if (!activeEventSelect.value || !nfcInput.value.trim()) return;
    scanTimer = window.setTimeout(() => nfcForm.requestSubmit(), 350);
});

async function queueOfflineCheckin(uid, eventId) {
    const member = members.find((item) => normalizeUid(item.nfc_uid) === normalizeUid(uid));
    if (!member) throw new Error('This card is not in the cached roster. Connect to Wi-Fi and refresh the dashboard before checking in offline.');
    const selectedEvent = events.find((item) => Number(item.id) === Number(eventId) && !item.closed_at);
    if (!selectedEvent) throw new Error('This open event is not in the offline cache. Connect to Wi-Fi and refresh the dashboard first.');

    const existing = await window.offlineStore.listCheckins();
    if (existing.some((item) => item.status === 'pending'
        && normalizeUid(item.nfc_uid) === normalizeUid(uid)
        && Number(item.eventId) === Number(eventId))) {
        throw new Error(`${member.name} is already queued for this event on this device.`);
    }

    await window.offlineStore.addCheckin({
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        nfc_uid: normalizeUid(uid),
        eventId: Number(eventId),
        createdAt: new Date().toISOString(),
        memberName: member.name,
        customId: member.custom_id,
        eventName: selectedEvent.name,
        points: Number(selectedEvent.points),
        status: 'pending',
        error: ''
    });
}

async function syncOfflineCheckins() {
    if (syncInProgress || !navigator.onLine || !cloudReachable) return;
    syncInProgress = true;
    let syncedAny = false;
    try {
        const queue = await window.offlineStore.listCheckins();
        for (const item of queue.filter((checkin) => checkin.status === 'pending')) {
            try {
                await api('/api/attendance', {
                    method: 'POST',
                    body: JSON.stringify({ nfc_uid: item.nfc_uid, event_id: item.eventId })
                });
                await window.offlineStore.removeCheckin(item.id);
                syncedAny = true;
            } catch (error) {
                if (isNetworkError(error)) break;
                if (error.status === 409 && /already checked in|already checked|already recorded/i.test(error.message)) {
                    await window.offlineStore.removeCheckin(item.id);
                    syncedAny = true;
                    continue;
                }
                if (error.status >= 500 || error.status === 429) break;
                item.status = 'failed';
                item.error = error.message;
                await window.offlineStore.updateCheckin(item);
            }
        }
    } catch (error) {
        console.error('Could not sync offline check-ins:', error);
    } finally {
        syncInProgress = false;
        await renderAttendanceWithQueuedCheckins();
    }
    if (syncedAny) await refreshData(false);
}

document.getElementById('scan-log-container').addEventListener('click', async (event) => {
    const retryButton = event.target.closest('[data-retry-offline]');
    const dismissButton = event.target.closest('[data-dismiss-offline]');
    if (!retryButton && !dismissButton) return;
    const id = (retryButton || dismissButton).dataset.retryOffline || (retryButton || dismissButton).dataset.dismissOffline;
    try {
        const item = (await window.offlineStore.listCheckins()).find((checkin) => checkin.id === id);
        if (!item) return;
        if (dismissButton) {
            if (!window.confirm('Remove this failed offline check-in from this device? It will not be sent to the cloud.')) return;
            await window.offlineStore.removeCheckin(id);
        } else {
            item.status = 'pending';
            item.error = '';
            await window.offlineStore.updateCheckin(item);
        }
        await renderAttendanceWithQueuedCheckins();
        if (retryButton) await syncOfflineCheckins();
    } catch (error) {
        showToast(error.message || 'Could not update the offline check-in.', true);
    }
});

nfcForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    window.clearTimeout(scanTimer);
    scanTimer = null;
    if (scanInProgress) return;

    const uid = nfcInput.value.trim();
    const eventId = activeEventSelect.value;
    nfcInput.value = '';
    if (!uid) return;
    if (!eventId) {
        feedback.textContent = 'Select an event before scanning.';
        feedback.className = 'scan-feedback error';
        return;
    }

    scanInProgress = true;
    feedback.className = 'scan-feedback';
    feedback.textContent = 'Recording check-in…';
    try {
        const result = await api('/api/attendance', {
            method: 'POST',
            body: JSON.stringify({ nfc_uid: uid, event_id: Number(eventId) })
        });
        feedback.className = 'scan-feedback success';
        feedback.textContent = `Checked in ${result.member} · +${result.pointsAwarded} points`;
        await refreshData();
        showToast(`${result.member} checked in for ${result.event}.`);
    } catch (error) {
        if (isNetworkError(error)) {
            try {
                await queueOfflineCheckin(uid, eventId);
                feedback.className = 'scan-feedback success';
                feedback.textContent = 'Check-in saved on this device. It will sync when Wi-Fi returns.';
                await renderAttendanceWithQueuedCheckins();
            } catch (queueError) {
                feedback.className = 'scan-feedback error';
                feedback.textContent = queueError.message;
            }
        } else {
            feedback.className = 'scan-feedback error';
            feedback.textContent = error.message;
        }
    } finally {
        scanInProgress = false;
        if (!activeEventSelect.value) nfcInput.disabled = true;
        else nfcInput.focus();
    }
});

const phoneNfcButton = document.getElementById('phone-nfc-scan');
const phoneNfcHint = document.getElementById('phone-nfc-hint');
if ('NDEFReader' in window) {
    phoneNfcButton.classList.remove('hidden');
    phoneNfcHint.textContent = 'Android Chrome over HTTPS: this reads a card NDEF text record containing the registered UID. Web NFC cannot read a card’s hardware UID directly.';
} else {
    phoneNfcHint.textContent = 'Phone NFC scanning requires Android Chrome over HTTPS and an NFC card containing an NDEF text record with its registered UID. Use a PC/SC reader for UID-only cards or unsupported phones.';
}
phoneNfcHint.classList.remove('hidden');
phoneNfcButton.addEventListener('click', async () => {
    if (!activeEventSelect.value) {
        feedback.textContent = 'Select an event before scanning.';
        feedback.className = 'scan-feedback error';
        return;
    }
    if (!('NDEFReader' in window)) return;
    const controller = new AbortController();
    try {
        const reader = new window.NDEFReader();
        await reader.scan({ signal: controller.signal });
        phoneNfcButton.disabled = true;
        phoneNfcButton.textContent = 'Hold card near phone…';
        feedback.textContent = 'Waiting for an NDEF text record…';
        reader.addEventListener('reading', (event) => {
            const textRecord = Array.from(event.message.records).find((record) => record.recordType === 'text');
            if (!textRecord) {
                feedback.textContent = 'This card has no NDEF text record containing a UID.';
                feedback.className = 'scan-feedback error';
                return;
            }
            const uid = new TextDecoder(textRecord.encoding || 'utf-8').decode(textRecord.data).trim();
            if (!uid) {
                feedback.textContent = 'The card’s NDEF text record is empty.';
                feedback.className = 'scan-feedback error';
                return;
            }
            controller.abort();
            nfcInput.value = uid;
            nfcForm.requestSubmit();
        }, { once: true });
        reader.addEventListener('readingerror', () => {
            feedback.textContent = 'Could not read the card. Try again or use the PC/SC reader.';
            feedback.className = 'scan-feedback error';
        }, { once: true });
    } catch (error) {
        showToast(error.message || 'This phone could not start NFC scanning.', true);
    } finally {
        phoneNfcButton.disabled = false;
        phoneNfcButton.textContent = 'Scan card with this phone';
    }
});

function setReaderStatus(connected, readerName = '') {
    const badge = document.getElementById('reader-status');
    const label = document.getElementById('reader-status-text');
    badge.classList.toggle('offline', !connected);
    label.textContent = connected
        ? `PC/SC CONNECTED${readerName ? ` · ${readerName}` : ''}`
        : 'READER BRIDGE OFFLINE';
}

function handleDirectReaderScan(uid) {
    if (document.getElementById('tab-attendance').classList.contains('hidden')) {
        showToast('Card detected. Open NFC check-in and select an event.', true);
        return;
    }
    if (!activeEventSelect.value) {
        feedback.className = 'scan-feedback error';
        feedback.textContent = 'Card detected. Select an event before checking in.';
        return;
    }
    if (scanInProgress) {
        showToast('A check-in is still processing. Please tap again in a moment.', true);
        return;
    }
    nfcInput.value = uid;
    nfcForm.requestSubmit();
}

const localReaderPort = new URLSearchParams(window.location.search).get('localReaderPort');
function handleReaderMessage(message) {
    try {
        const event = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
        if (event.type === 'status') setReaderStatus(event.connected, event.reader);
        if (event.type === 'scan') handleDirectReaderScan(event.uid);
    } catch (error) {
        console.error('Invalid NFC reader event:', error);
    }
}

if (window.ncggReader) {
    window.ncggReader.onEvent(handleReaderMessage);
} else {
    const readerStream = new EventSource('/api/reader/stream');
    readerStream.onmessage = handleReaderMessage;
    readerStream.onerror = () => setReaderStatus(false);
}

document.getElementById('event-date').value = getGuildDateString();
updateMemberTierVisibility();
api('/api/status').then((status) => {
    databaseMode = status.database;
    return updateNetworkStatus();
}).catch((error) => {
    console.error('Could not check database status:', error);
    updateNetworkStatus();
});
api('/api/auth/me').then((result) => {
    authenticatedStaff = result.staff;
    setView(authenticatedStaff.role);
}).catch(() => setView('member')).finally(() => {
    refreshData();
    window.setInterval(refreshData, 15000);
});

window.addEventListener('online', () => {
    updateNetworkStatus();
    refreshData();
});
window.addEventListener('offline', () => {
    updateNetworkStatus();
    refreshData();
});
