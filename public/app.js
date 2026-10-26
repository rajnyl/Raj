const loginOverlay = document.getElementById('login-overlay');
const nfcForm = document.getElementById('nfc-form');
const nfcInput = document.getElementById('nfc-input');
const activeEventSelect = document.getElementById('active-event-select');
const feedback = document.getElementById('scan-feedback');
const GUILD_TIME_ZONE = 'Asia/Manila';

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
let pointAdjustments = [];
let announcements = [];
let eventTasks = [];
let taskCalendarDate = getGuildCalendarStart();
let activityCalendarDate = getGuildCalendarStart();
let taskView = 'board';
let currentView = 'member';
let authenticatedStaff = null;
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
            api('/api/members'), api('/api/events'), api('/api/attendance'), loadAnnouncements()
        ]);
        cloudReachable = true;
        members = nextMembers;
        events = nextEvents;
        attendance = nextAttendance;
        announcements = nextAnnouncements;
        pointAdjustments = authenticatedStaff ? await api('/api/points/adjustments') : [];
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
    const staffMembers = members.filter((member) => ['Officer', 'Executive', 'Admin'].includes(member.role));
    select.innerHTML = '<option value="">Select a staff account</option>' + staffMembers.map((member) =>
        `<option value="${escapeHtml(member.custom_id)}">${escapeHtml(member.name)} · ${escapeHtml(member.custom_id)} · ${escapeHtml(member.role)}</option>`
    ).join('');
    if (staffMembers.some((member) => member.custom_id === selected)) select.value = selected;
}

function renderAnnouncements() {
    const container = document.getElementById('announcements-list');
    if (!announcements.length) {
        container.innerHTML = '<div class="empty-state">No announcements yet.</div>';
        return;
    }
    container.innerHTML = announcements.map((announcement) => {
        const date = parseServerTimestamp(announcement.created_at);
        const dateText = date && !Number.isNaN(date.valueOf()) ? date.toLocaleString() : '';
        const reactions = ['👍', '❤️', '🎮', '🔥'];
        return `<article class="panel announcement-card">
            <div class="panel-heading"><div><h2>${escapeHtml(announcement.title)}</h2><p class="muted">${escapeHtml(announcement.author_name)} · ${escapeHtml(announcement.author_role)}${dateText ? ` · ${escapeHtml(dateText)}` : ''}</p></div></div>
            <p class="announcement-body">${escapeHtml(announcement.body)}</p>
            <div class="announcement-reactions" role="group" aria-label="Reactions">
                ${reactions.map((reaction) => {
                    const count = Number(announcement.reaction_counts?.[reaction] || 0);
                    const selected = announcement.user_reaction === reaction;
                    return `<button class="announcement-reaction${selected ? ' selected' : ''}" type="button" data-announcement-reaction="${Number(announcement.id)}" data-reaction="${reaction}" aria-pressed="${selected}" aria-label="${reaction} reaction, ${count} ${count === 1 ? 'reaction' : 'reactions'}">
                        <span aria-hidden="true">${reaction}</span><span>${count}</span>
                    </button>`;
                }).join('')}
            </div>
        </article>`;
    }).join('');
}

function renderTaskEventOptions() {
    const select = document.getElementById('task-event-select');
    if (!select) return;
    const selected = select.value;
    select.innerHTML = '<option value="">Select an event</option>' + events.map((event) =>
        `<option value="${Number(event.id)}">${escapeHtml(event.name)} · ${escapeHtml(event.event_date)}</option>`
    ).join('');
    if (events.some((event) => String(event.id) === selected)) select.value = selected;
}

function renderTaskAssigneeOptions() {
    const staff = members.filter((member) => ['Officer', 'Executive', 'Admin'].includes(member.role) && member.custom_id);
    const options = staff.map((member) =>
        `<option value="${escapeHtml(member.custom_id)}">${escapeHtml(member.name)} · ${escapeHtml(member.custom_id)} · ${escapeHtml(member.role)}</option>`
    ).join('');
    const createSelect = document.getElementById('task-assignees');
    const filterSelect = document.getElementById('task-filter-assignee');
    if (createSelect) createSelect.innerHTML = options || '<option disabled>No staff members available</option>';
    if (filterSelect) {
        const selected = filterSelect.value;
        filterSelect.innerHTML = '<option value="">All assignees</option>' + options;
        if (staff.some((member) => member.custom_id === selected)) filterSelect.value = selected;
    }
}

async function loadEventTasks() {
    const eventId = document.getElementById('task-event-select').value;
    const container = document.getElementById('event-task-list');
    if (!eventId) {
        eventTasks = [];
        container.innerHTML = '<div class="empty-state">Select an event to view its committee tasks.</div>';
        return;
    }
    try {
        eventTasks = await api(`/api/tasks?event_id=${encodeURIComponent(eventId)}`);
        renderEventTasks();
    } catch (error) {
        container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
}

function renderEventTasks() {
    const container = document.getElementById('event-task-list');
    if (!document.getElementById('task-event-select').value) {
        container.innerHTML = '<div class="empty-state">Select an event to view its committee tasks.</div>';
        renderTaskCalendar();
        return;
    }
    if (!eventTasks.length) {
        container.innerHTML = '<div class="empty-state">No tasks for this event yet. Add the first task above.</div>';
        renderTaskCalendar();
        return;
    }
    const statusFilter = document.getElementById('task-filter-status').value;
    const priorityFilter = document.getElementById('task-filter-priority').value;
    const assigneeFilter = document.getElementById('task-filter-assignee').value;
    const search = document.getElementById('task-search').value.trim().toLowerCase();
    const visibleTasks = eventTasks.filter((task) => {
        const assigneeMembers = members.filter((member) => task.assignees.includes(member.custom_id));
        const searchable = `${task.title} ${task.committee} ${task.description} ${assigneeMembers.map((member) => `${member.name} ${member.custom_id}`).join(' ')}`.toLowerCase();
        return (!statusFilter || task.status === statusFilter)
            && (!priorityFilter || task.priority === priorityFilter)
            && (!assigneeFilter || task.assignees.includes(assigneeFilter))
            && (!search || searchable.includes(search));
    });
    if (!visibleTasks.length) {
        container.innerHTML = '<div class="empty-state">No tasks match the selected filters.</div>';
        renderTaskCalendar(visibleTasks);
        return;
    }
    const committees = new Map();
    visibleTasks.forEach((task) => {
        if (!committees.has(task.committee)) committees.set(task.committee, []);
        committees.get(task.committee).push(task);
    });
    container.innerHTML = [...committees.entries()].map(([committee, tasks]) => {
        const completedCount = tasks.filter((task) => task.status === 'Complete').length;
        const overallProgress = Math.round(tasks.reduce((total, task) => total + Number(task.progress || 0), 0) / tasks.length);
        return `
        <section class="committee-section">
            <div class="committee-heading">
                <div><h2>${escapeHtml(committee)}</h2><span>${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} · ${completedCount} complete</span></div>
                <div class="committee-progress"><progress max="100" value="${overallProgress}"></progress><span>${overallProgress}% overall</span></div>
            </div>
            <div class="table-wrap task-table-wrap">
                <table class="task-table">
                    <thead><tr><th>TASK</th><th>ASSIGNED OFFICERS</th><th>STATUS</th><th>DEADLINE</th><th>PRIORITY</th><th>UPDATE</th><th>DETAILS</th></tr></thead>
                    <tbody>${tasks.map((task) => {
                        const taskId = Number(task.id);
                        const formId = `task-update-${taskId}`;
                        const priority = String(task.priority);
                        const status = task.status || (Number(task.progress) >= 100 ? 'Complete' : Number(task.progress) > 0 ? 'Open' : 'Not started');
                        const taskAssigneeIds = task.assignees || [];
                        const taskStaff = members.filter((member) => ['Officer', 'Executive', 'Admin'].includes(member.role) && member.custom_id);
                        const deadlineText = task.deadline
                            ? formatGuildDate(task.deadline)
                            : '';
                        const isOverdue = task.deadline && task.deadline < getGuildDateString() && status !== 'Complete';
                        const subtasks = task.subtasks || [];
                        const completedSubtasks = subtasks.filter((subtask) => subtask.completed === true || Number(subtask.completed) === 1).length;
                        return `
                        <tr class="task-table-row" id="task-row-${taskId}">
                            <td class="task-title-cell">
                                <form id="${formId}" data-task-update="${taskId}"></form>
                                <strong>${escapeHtml(task.title)}</strong>
                                <small>Added by ${escapeHtml(task.created_by)}</small>
                                ${task.description ? `<span class="task-table-description">${escapeHtml(task.description)}</span>` : ''}
                            </td>
                            <td><select class="field task-assignees-select" name="assignees" form="${formId}" multiple aria-label="Assigned officers for ${escapeHtml(task.title)}" size="3">
                                ${taskStaff.map((member) => `<option value="${escapeHtml(member.custom_id)}"${taskAssigneeIds.includes(member.custom_id) ? ' selected' : ''}>${escapeHtml(member.name)} · ${escapeHtml(member.custom_id)}</option>`).join('')}
                            </select></td>
                            <td><select class="field task-status-select status-${status.toLowerCase().replace(/\s+/g, '-')}" name="status" form="${formId}" aria-label="Status for ${escapeHtml(task.title)}">
                                ${['Not started', 'Open', 'Complete'].map((option) => `<option${status === option ? ' selected' : ''}>${option}</option>`).join('')}
                            </select></td>
                            <td class="task-deadline-cell">
                                <input class="field task-deadline-input${isOverdue ? ' overdue' : ''}" type="date" name="deadline" form="${formId}" value="${escapeHtml(task.deadline || '')}" aria-label="Deadline for ${escapeHtml(task.title)}">
                                ${isOverdue ? '<small class="overdue-label">Overdue</small>' : ''}
                                ${!task.deadline ? '<small class="no-deadline-label">No deadline</small>' : ''}
                            </td>
                            <td><select class="field task-priority-select priority-${priority.toLowerCase()}" name="priority" form="${formId}" aria-label="Priority for ${escapeHtml(task.title)}">
                                <option${priority === 'Low' ? ' selected' : ''}>Low</option>
                                <option${priority === 'Medium' ? ' selected' : ''}>Medium</option>
                                <option${priority === 'High' ? ' selected' : ''}>High</option>
                            </select></td>
                            <td><button class="button button-secondary task-save-button" type="submit" form="${formId}">Save</button></td>
                            <td><span class="task-detail-count">${completedSubtasks}/${subtasks.length} subtasks · ${task.comments.length} comments · ${task.attachments.length + (task.link_url ? 1 : 0)} files/links</span></td>
                        </tr>
                        <tr class="task-details-row"><td colspan="7">
                            <details class="task-details">
                                <summary>Task details, subtasks, comments &amp; files</summary>
                                <div class="task-details-content">
                                    <section class="task-edit-section"><h4>Edit task</h4>
                                        <form class="task-edit-form" data-task-edit="${taskId}">
                                            <label>TASK TITLE<input class="field" name="title" maxlength="160" required value="${escapeHtml(task.title)}"></label>
                                            <label>COMMITTEE<input class="field" name="committee" maxlength="100" required value="${escapeHtml(task.committee)}"></label>
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
                                    <section class="task-comments"><h4>Comments (${task.comments.length})</h4>
                                        ${task.comments.length ? task.comments.map((comment) => {
                                            const date = parseServerTimestamp(comment.created_at);
                                            const dateText = date && !Number.isNaN(date.valueOf()) ? date.toLocaleString() : '';
                                            return `<p class="task-comment"><strong>${escapeHtml(comment.author_name)}</strong>${dateText ? `<small>${escapeHtml(dateText)}</small>` : ''}<span>${escapeHtml(comment.body)}</span></p>`;
                                        }).join('') : '<p class="muted task-no-comments">No comments yet.</p>'}
                                        <form class="task-comment-form" data-task-comment="${taskId}"><input class="field" name="body" maxlength="2000" required placeholder="Add a comment"><button class="button button-secondary" type="submit">Comment</button></form>
                                    </section>
                                    <section class="task-attachments"><h4>Files and links</h4>
                                        ${task.link_url ? `<a class="task-attachment" href="${escapeHtml(task.link_url)}" target="_blank" rel="noopener noreferrer">↗ Open task link</a>` : ''}
                                        ${task.attachments.map((attachment) => `
                                            <a class="task-attachment" href="/api/tasks/${taskId}/attachments/${Number(attachment.id)}" target="_blank" rel="noopener noreferrer">↗ ${escapeHtml(attachment.filename)}</a>
                                        `).join('')}
                                        ${!task.link_url && !task.attachments.length ? '<p class="muted task-no-comments">No files or links attached.</p>' : ''}
                                        <form class="task-attachment-form" data-task-attachment="${taskId}">
                                            <input class="field" type="file" name="files" accept="application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png,image/gif,.gif,image/webp,.webp" multiple required>
                                            <button class="button button-secondary" type="submit">Upload files</button>
                                        </form>
                                    </section>
                                </div>
                            </details>
                        </td></tr>`;
                    }).join('')}</tbody>
                </table>
            </div>
        </section>`;
    }).join('');
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
    document.querySelectorAll('[data-task-view]').forEach((button) =>
        button.classList.toggle('active', button.dataset.taskView === view)
    );
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
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const slotCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const todayString = getGuildDateString();
    const eventsByDate = new Map();
    events.forEach((guildEvent) => {
        const date = String(guildEvent.event_date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
        if (!eventsByDate.has(date)) eventsByDate.set(date, []);
        eventsByDate.get(date).push(guildEvent);
    });
    const dayCells = Array.from({ length: slotCount }, (_, index) => {
        const day = index - firstWeekday + 1;
        if (day < 1 || day > daysInMonth) return '<div class="calendar-day outside-month" aria-hidden="true"></div>';
        const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayEvents = eventsByDate.get(dateKey) || [];
        return `<div class="calendar-day${dateKey === todayString ? ' today' : ''}" aria-label="${dateKey}, ${dayEvents.length} events">
            <span class="calendar-day-number">${day}</span>
            <div class="calendar-day-tasks">${dayEvents.map((guildEvent) =>
                `<div class="activity-calendar-event${guildEvent.closed_at ? ' closed' : ''}" title="${escapeHtml(guildEvent.name)} · +${Number(guildEvent.points)} pts${guildEvent.closed_at ? ' · Closed' : ''}">
                    <strong>${escapeHtml(guildEvent.name)}</strong><span>+${Number(guildEvent.points)} pts${guildEvent.closed_at ? ' · Closed' : ''}</span>
                </div>`
            ).join('')}</div>
        </div>`;
    }).join('');
    calendar.innerHTML = `<div class="calendar-weekdays">${weekdays.map((weekday) => `<span>${weekday}</span>`).join('')}</div>
        <div class="calendar-days">${dayCells}</div>
        ${!events.length ? '<p class="calendar-empty-note">No guild events have been created yet.</p>' : ''}`;
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
    const staffTab = ['tab-members', 'tab-events', 'tab-points', 'tab-tasks'].includes(tabId);
    if (staffTab && currentView === 'member') return;
    if (tabId === 'tab-admin' && currentView !== 'admin') return;

    document.querySelectorAll('.tab-content').forEach((tab) => tab.classList.toggle('hidden', tab.id !== tabId));
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.target === tabId));
    const titles = {
        'tab-dashboard': 'Guild overview',
        'tab-attendance': 'NFC check-in',
        'tab-calendar': 'Guild activity calendar',
        'tab-members': 'Member database',
        'tab-events': 'Event management',
        'tab-points': 'Points adjustment',
        'tab-announcements': 'Guild announcements',
        'tab-tasks': 'Event task tracker',
        'tab-admin': 'Admin workspace'
    };
    document.getElementById('page-title').textContent = titles[tabId] || 'NCGG dashboard';
    if (tabId === 'tab-tasks' && currentView !== 'member') void loadEventTasks();
    if (tabId === 'tab-attendance' && activeEventSelect.value) window.setTimeout(() => nfcInput.focus(), 80);
}

function setView(role) {
    if (currentView === 'admin' && role !== 'admin') {
        members = members.map(({ nfc_uid, ...member }) => member);
    }
    currentView = role;
    if (role === 'member') authenticatedStaff = null;
    const isOfficer = ['officer', 'executive', 'admin'].includes(role);
    document.querySelectorAll('.staff-only').forEach((element) => element.classList.toggle('hidden', !isOfficer));
    document.querySelectorAll('.executive-only').forEach((element) => element.classList.toggle('hidden', !['executive', 'admin'].includes(role)));
    document.querySelectorAll('.admin-only').forEach((element) => element.classList.toggle('hidden', role !== 'admin'));
    document.querySelectorAll('.task-staff-only').forEach((element) => element.classList.toggle('hidden', !isOfficer));
    document.querySelectorAll('.announcement-publisher').forEach((element) =>
        element.classList.toggle('hidden', !['officer', 'executive', 'admin'].includes(role))
    );
    document.querySelectorAll('#member-role option').forEach((option) => {
        option.disabled = isOfficer && !['executive', 'admin'].includes(role) && option.value !== 'Member';
    });
    renderMembers();
    document.getElementById('display-role').textContent = role.charAt(0).toUpperCase() + role.slice(1);
    document.getElementById('user-avatar').textContent = role.charAt(0).toUpperCase();
    document.getElementById('btn-logout').textContent = isOfficer ? 'Sign out' : 'Staff sign in';
    loginOverlay.classList.add('hidden');
    openTab('tab-dashboard');
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

document.getElementById('btn-member-view').addEventListener('click', () => setView('member'));
document.getElementById('btn-logout').addEventListener('click', async () => {
    if (authenticatedStaff) {
        try {
            await api('/api/auth/logout', { method: 'POST' });
        } catch (error) {
            showToast(error.message, true);
        }
        setView('member');
        await refreshData();
        showToast('Signed out.');
        return;
    }
    document.getElementById('login-error').classList.add('hidden');
    loginOverlay.classList.remove('hidden');
    document.getElementById('login-guild-id').focus();
});

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => openTab(button.dataset.target)));
document.querySelectorAll('[data-open-tab]').forEach((button) => button.addEventListener('click', () => openTab(button.dataset.openTab)));

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
        showToast('Staff password saved. Share it securely with the account holder.');
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
    const payload = {
        title: document.getElementById('announcement-title').value.trim(),
        body: document.getElementById('announcement-body').value.trim()
    };
    try {
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
    const button = event.target.closest('[data-announcement-reaction]');
    if (!button) return;
    button.disabled = true;
    try {
        await api(`/api/announcements/${button.dataset.announcementReaction}/reactions`, {
            method: 'POST',
            body: JSON.stringify({
                reactor_id: getAnnouncementReactorId(),
                reaction: button.dataset.reaction
            })
        });
        announcements = await loadAnnouncements();
        renderAnnouncements();
    } catch (error) {
        showToast(error.message, true);
    } finally {
        button.disabled = false;
    }
});

document.getElementById('form-create-task').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
        event_id: Number(document.getElementById('task-event-select').value),
        committee: document.getElementById('task-committee').value.trim(),
        title: document.getElementById('task-title').value.trim(),
        priority: document.getElementById('task-priority').value,
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
        document.getElementById('task-assignees').selectedIndex = -1;
        document.getElementById('task-status').value = 'Not started';
        await loadEventTasks();
        showToast('Event task added.');
    } catch (error) {
        showToast(error.message, true);
    }
});

document.getElementById('task-event-select').addEventListener('change', () => void loadEventTasks());

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
    renderActivityCalendar();
});
document.getElementById('activity-calendar-next').addEventListener('click', () => {
    activityCalendarDate = new Date(activityCalendarDate.getFullYear(), activityCalendarDate.getMonth() + 1, 1);
    renderActivityCalendar();
});
document.getElementById('activity-calendar-today').addEventListener('click', () => {
    activityCalendarDate = getGuildCalendarStart();
    renderActivityCalendar();
});
document.getElementById('task-calendar').addEventListener('click', (event) => {
    const taskButton = event.target.closest('[data-calendar-task]');
    if (!taskButton) return;
    setTaskView('board');
    const row = document.getElementById(`task-row-${taskButton.dataset.calendarTask}`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.nextElementSibling?.querySelector('.task-details')?.setAttribute('open', '');
});

const eventTaskList = document.getElementById('event-task-list');
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
                    link_url: editForm.elements.link_url.value.trim()
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
