const loginOverlay = document.getElementById('login-overlay');
const nfcForm = document.getElementById('nfc-form');
const nfcInput = document.getElementById('nfc-input');
const activeEventSelect = document.getElementById('active-event-select');
const feedback = document.getElementById('scan-feedback');

let members = [];
let events = [];
let attendance = [];
let pointAdjustments = [];
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
        const [nextMembers, nextEvents, nextAttendance] = await Promise.all([
            api('/api/members'), api('/api/events'), api('/api/attendance')
        ]);
        cloudReachable = true;
        members = nextMembers;
        events = nextEvents;
        attendance = nextAttendance;
        pointAdjustments = authenticatedStaff ? await api('/api/points/adjustments') : [];
        const snapshots = { events, attendance };
        if (authenticatedStaff && members.every((member) => typeof member.nfc_uid === 'string')) {
            snapshots.members = members;
        }
        await window.offlineStore.saveSnapshots(snapshots);
        renderDashboard();
        renderMembers();
        renderEvents();
        renderEventOptions();
        renderPointsMemberOptions();
        renderPointHistory();
        renderStaffPasswordOptions();
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
            members = cachedMembers || [];
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
    const staffMembers = members.filter((member) => member.role === 'Officer' || member.role === 'Executive');
    select.innerHTML = '<option value="">Select a staff account</option>' + staffMembers.map((member) =>
        `<option value="${escapeHtml(member.custom_id)}">${escapeHtml(member.name)} · ${escapeHtml(member.custom_id)} · ${escapeHtml(member.role)}</option>`
    ).join('');
    if (staffMembers.some((member) => member.custom_id === selected)) select.value = selected;
}

function renderDashboard() {
    const today = new Date().toISOString().slice(0, 10);
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
    document.getElementById('members-table-body').innerHTML = regularMembers.length ? regularMembers.map((member) => `
        <tr>
            <td><span class="guild-id">${escapeHtml(member.custom_id || '—')}</span></td>
            <td><strong>${escapeHtml(member.name)}</strong></td>
            <td><span class="role-pill">${escapeHtml(member.tier || 'Regular')}</span></td>
            <td><span class="uid-text" title="${escapeHtml(member.nfc_uid)}">${escapeHtml(member.nfc_uid)}</span></td>
            <td class="align-right points-cell">${Number(member.points || 0).toLocaleString()}</td>
        </tr>`).join('') : `<tr><td colspan="5" class="empty-cell">${members.some((member) => member.role === 'Member') ? 'No matching members.' : 'No members registered yet.'}</td></tr>`;
    document.getElementById('officers-table-body').innerHTML = officers.length ? officers.map((member) => `
        <tr>
            <td><span class="guild-id">${escapeHtml(member.custom_id || '—')}</span></td>
            <td><strong>${escapeHtml(member.name)}</strong></td>
            <td><span class="role-pill">${escapeHtml(member.role)}</span></td>
            <td><span class="uid-text" title="${escapeHtml(member.nfc_uid)}">${escapeHtml(member.nfc_uid)}</span></td>
            <td class="align-right points-cell">${Number(member.points || 0).toLocaleString()}</td>
        </tr>`).join('') : `<tr><td colspan="5" class="empty-cell">${members.some((member) => member.role !== 'Member') ? 'No matching officers.' : 'No officers registered yet.'}</td></tr>`;
}

function renderEvents() {
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
            <td class="align-right event-actions">${!event.closed_at && currentView === 'executive' ? `<button class="button button-close-event" type="button" data-close-event="${Number(event.id)}">Close</button>` : ''}<button class="button button-delete" type="button" data-delete-event="${Number(event.id)}">Delete</button></td>
        </tr>`).join('');
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
        `<option value="${escapeHtml(member.nfc_uid)}">${escapeHtml(member.name)} · ${escapeHtml(member.custom_id || member.nfc_uid)} · ${Number(member.points || 0)} pts</option>`
    ).join('');
    if (members.some((member) => member.nfc_uid === selected)) select.value = selected;
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
    const protectedTab = ['tab-members', 'tab-events', 'tab-points'].includes(tabId);
    if (protectedTab && currentView === 'member') return;

    document.querySelectorAll('.tab-content').forEach((tab) => tab.classList.toggle('hidden', tab.id !== tabId));
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.target === tabId));
    const titles = {
        'tab-dashboard': 'Guild overview',
        'tab-attendance': 'NFC check-in',
        'tab-members': 'Member database',
        'tab-events': 'Event management',
        'tab-points': 'Points adjustment'
    };
    document.getElementById('page-title').textContent = titles[tabId] || 'NCGG dashboard';
    if (tabId === 'tab-attendance' && activeEventSelect.value) window.setTimeout(() => nfcInput.focus(), 80);
}

function setView(role) {
    currentView = role;
    if (role === 'member') authenticatedStaff = null;
    const isOfficer = role === 'officer' || role === 'executive';
    document.querySelectorAll('.staff-only').forEach((element) => element.classList.toggle('hidden', !isOfficer));
    document.querySelectorAll('.executive-only').forEach((element) => element.classList.toggle('hidden', role !== 'executive'));
    document.querySelectorAll('#member-role option').forEach((option) => {
        option.disabled = isOfficer && role !== 'executive' && option.value !== 'Member';
    });
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
        document.getElementById('event-date').value = new Date().toISOString().slice(0, 10);
        document.getElementById('event-points').value = '10';
        await refreshData();
        showToast('Event published. It is now available for check-in.');
    } catch (error) {
        showToast(error.message, true);
    }
});

document.getElementById('form-adjust-points').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!['officer', 'executive'].includes(currentView)) {
        showToast('Only officers and executives can adjust points.', true);
        return;
    }

    const memberUid = document.getElementById('points-member').value;
    const amount = Number(document.getElementById('points-amount').value);
    const direction = document.getElementById('points-direction').value;
    const reason = document.getElementById('points-reason').value.trim();
    const member = members.find((item) => item.nfc_uid === memberUid);
    if (!member) {
        showToast('Select a registered member first.', true);
        return;
    }
    if (direction === 'deduct' && !window.confirm(`Deduct ${amount} points from ${member.name}?`)) return;

    try {
        const result = await api('/api/points/adjust', {
            method: 'POST',
            body: JSON.stringify({ nfc_uid: memberUid, amount, direction, reason })
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
        if (currentView !== 'executive') {
            showToast('Only executives can close events.', true);
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
const readerStream = new EventSource(localReaderPort
    ? `http://127.0.0.1:${encodeURIComponent(localReaderPort)}/events`
    : '/api/reader/stream');
readerStream.onmessage = (message) => {
    try {
        const event = JSON.parse(message.data);
        if (event.type === 'status') setReaderStatus(event.connected, event.reader);
        if (event.type === 'scan') handleDirectReaderScan(event.uid);
    } catch (error) {
        console.error('Invalid NFC reader event:', error);
    }
};
readerStream.onerror = () => setReaderStatus(false);

document.getElementById('event-date').value = new Date().toISOString().slice(0, 10);
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

