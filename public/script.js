// ============================================================
//  INITIALIZATION
// ============================================================

let authState = null;
let usersCache = [];
let liveEvents = null;
let sessionCheckInProgress = false;
const JOB_STATUSES = ['Pending', 'In Progress', 'Waiting on Requester', 'On Hold', 'Completed', 'Cancelled'];
const PAGE_SIZE = 50;
const paginationPages = {};

document.addEventListener('DOMContentLoaded', () => {
    const now = new Date();
    const today = toDateInputValue(now);
    document.getElementById('reportStartDate').value = `${today.slice(0, 7)}-01`;
    document.getElementById('reportEndDate').value = today;
    document.querySelector('[name="dueDate"]').min = today;
    const defaultJobFollowUp = new Date();
    defaultJobFollowUp.setDate(defaultJobFollowUp.getDate() + 7);
    document.getElementById('jobFollowUpDate').value = toDateInputValue(defaultJobFollowUp);

    document.querySelectorAll('#content-consumables, #content-equipment, #content-jobs').forEach(section => {
        section.addEventListener('click', (event) => {
            const button = event.target.closest('.form-toggle > button');
            if (button) toggleFormPanel(button);
        });
    });
    document.getElementById('equipmentTableBody').addEventListener('click', handleEquipmentAction);
    document.getElementById('inventoryTableBody').addEventListener('click', handleStockAction);
    document.getElementById('jobTableBody').addEventListener('click', handleJobAction);
    document.addEventListener('click', handlePaginationAction);
    document.getElementById('assetRegisterNavigation').addEventListener('click', (event) => {
        const button = event.target.closest('[data-asset-register-tab]');
        if (button) switchAssetRegisterTab(button.dataset.assetRegisterTab);
    });
    document.getElementById('assetRegisterSearch').addEventListener('input', renderAssetRegister);
    document.getElementById('assetRegisterTypeFilter').addEventListener('change', renderAssetRegister);
    document.getElementById('addAssetRegisterRecordButton').addEventListener('click', () => openAssetRegisterEditor());
    document.getElementById('assetRegisterPanels').addEventListener('click', handleAssetRegisterAction);
    document.getElementById('assetRegisterRecordForm').addEventListener('submit', saveAssetRegisterRecord);
    ['closeAssetRegisterRecordDialog', 'cancelAssetRegisterRecordButton'].forEach(id => {
        document.getElementById(id).addEventListener('click', closeAssetRegisterEditor);
    });
    document.getElementById('printAssetRegisterButton').addEventListener('click', printAssetRegister);
    window.addEventListener('afterprint', () => document.body.classList.remove('printing-asset-register'));

    [
        ['inventorySearch', renderInventory],
        ['inventoryCategoryFilter', renderInventory],
        ['inventoryStockFilter', renderInventory],
        ['inventorySort', renderInventory],
        ['requestSearch', renderRequests],
        ['equipmentSearch', () => resetAndRender('equipment', renderEquipment)],
        ['equipmentCategoryFilter', () => resetAndRender('equipment', renderEquipment)],
        ['equipmentStatusFilter', () => resetAndRender('equipment', renderEquipment)],
        ['equipmentSort', () => resetAndRender('equipment', renderEquipment)],
        ['activitySearch', () => resetAndRender('equipmentLogs', renderEquipmentLogs)],
        ['activityActionFilter', () => resetAndRender('equipmentLogs', renderEquipmentLogs)],
        ['activitySort', () => resetAndRender('equipmentLogs', renderEquipmentLogs)],
        ['jobSearch', renderJobs],
        ['jobStatusFilter', renderJobs]
    ].forEach(([id, handler]) => {
        document.getElementById(id).addEventListener('input', handler);
        document.getElementById(id).addEventListener('change', handler);
    });

    document.getElementById('editEquipmentForm').addEventListener('submit', saveEquipmentEdits);
    document.getElementById('editEquipmentForm').elements.status.addEventListener('change', updateEquipmentEditStatusFields);
    document.getElementById('addJobForm').addEventListener('submit', fileNewJob);
    document.getElementById('jobStatusForm').addEventListener('submit', saveJobStatus);
    document.getElementById('cancelJobStatusButton').addEventListener('click', () => document.getElementById('jobStatusDialog').close());
    ['reportStartDate', 'reportEndDate'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => {
            latestReportData = null;
            document.getElementById('exportReportButton').disabled = true;
        });
    });

    document.querySelectorAll('.form-panel').forEach(panel => {
        panel.addEventListener('transitionend', (event) => {
            if (event.propertyName === 'max-height' && panel.getAttribute('aria-hidden') === 'false') {
                panel.style.maxHeight = 'none';
            }
        });
    });

    document.getElementById('logoutButton').addEventListener('click', signOut);
    document.getElementById('changeOwnPasswordButton').addEventListener('click', () => {
        window.location.href = '/login.html?change-password=1';
    });
    document.getElementById('userCreateForm').addEventListener('submit', createUser);
    document.getElementById('userCreateForm').elements.role.addEventListener('change', updateCreatePermissionVisibility);
    document.getElementById('sendTelegramReportsButton').addEventListener('click', sendTelegramReportsNow);
    document.getElementById('telegramSettingsForm').addEventListener('submit', saveTelegramSettings);
    document.getElementById('userTableBody').addEventListener('click', handleUserAction);
    document.getElementById('userEditForm').elements.role.addEventListener('change', updateEditPermissionVisibility);
    document.getElementById('userEditForm').addEventListener('submit', saveUserAccess);
    document.getElementById('cancelUserEditButton').addEventListener('click', () => document.getElementById('userEditDialog').close());
    document.getElementById('copyTemporaryPasswordButton').addEventListener('click', copyTemporaryPassword);
    initializeAuthentication();
});

function connectLiveUpdates() {
    if (!window.EventSource) {
        setLiveUpdateStatus('Live updates are not supported by this browser.', 'disconnected');
        refreshSharedData();
        return;
    }

    const events = new EventSource('/api/events');
    events.addEventListener('connected', () => {
        setLiveUpdateStatus('Live updates connected', 'connected');
        refreshSharedData();
    });
    events.addEventListener('data-updated', refreshSharedData);
    events.onerror = () => {
        setLiveUpdateStatus('Reconnecting to live updates…', 'disconnected');
        if (sessionCheckInProgress) return;
        sessionCheckInProgress = true;
        fetch('/api/auth/status')
            .then(response => response.json())
            .then(result => {
                if (!result.authenticated) handleExpiredSession();
            })
            .catch(error => console.error('[Authentication] Could not verify the session:', error))
            .finally(() => { sessionCheckInProgress = false; });
    };
}

function setLiveUpdateStatus(message, state) {
    const status = document.getElementById('liveUpdateStatus');
    status.textContent = message;
    status.classList.toggle('connected', state === 'connected');
    status.classList.toggle('disconnected', state === 'disconnected');
}

async function refreshSharedData() {
    const tasks = [];
    if (hasPermission('consumablesView')) tasks.push(fetchConsumableData());
    if (hasPermission('equipmentView')) {
        tasks.push(fetchEquipmentData());
        tasks.push(fetchAssetRegister());
    }
    if (authState) tasks.push(fetchJobs());
    const results = await Promise.allSettled(tasks);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) {
        console.error('[Live updates] Failed to refresh shared data:', failed.reason);
        setLiveUpdateStatus('Connected, but some data could not be refreshed.', 'disconnected');
        return;
    }

    if (latestReportData && hasPermission('analyticsView')) await generateReport({ silent: true });
}

function toDateInputValue(date) {
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return localDate.toISOString().slice(0, 10);
}

function resetAndRender(pageKey, render) {
    paginationPages[pageKey] = 1;
    render();
}

function getPageItems(items, pageKey) {
    const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const page = Math.min(Math.max(1, paginationPages[pageKey] || 1), pageCount);
    paginationPages[pageKey] = page;
    return items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
}

function renderPaginationControls(containerId, pageKey, totalItems) {
    const container = document.getElementById(containerId);
    const pageCount = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
    const page = paginationPages[pageKey] || 1;
    if (totalItems <= PAGE_SIZE) {
        container.innerHTML = '';
        return;
    }

    const firstItem = (page - 1) * PAGE_SIZE + 1;
    const lastItem = Math.min(page * PAGE_SIZE, totalItems);
    container.innerHTML = `
        <nav class="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm" aria-label="Table pagination">
            <span class="text-gray-500">Showing ${firstItem}–${lastItem} of ${totalItems}</span>
            <div class="flex items-center gap-2">
                <button type="button" data-pagination-key="${pageKey}" data-pagination-page="${page - 1}" ${page === 1 ? 'disabled' : ''} class="rounded border px-3 py-1 disabled:cursor-not-allowed disabled:opacity-50">Previous</button>
                <span class="text-gray-600">Page ${page} of ${pageCount}</span>
                <button type="button" data-pagination-key="${pageKey}" data-pagination-page="${page + 1}" ${page === pageCount ? 'disabled' : ''} class="rounded border px-3 py-1 disabled:cursor-not-allowed disabled:opacity-50">Next</button>
            </div>
        </nav>`;
}

function handlePaginationAction(event) {
    const button = event.target.closest('[data-pagination-key][data-pagination-page]');
    if (!button || button.disabled) return;
    const pageKey = button.dataset.paginationKey;
    paginationPages[pageKey] = Number(button.dataset.paginationPage);
    const renderers = {
        equipment: renderEquipment,
        equipmentLogs: renderEquipmentLogs,
        reportItems: renderCurrentReport,
        reportRequestors: renderCurrentReport,
        reportStock: renderCurrentReport,
        reportEquipment: renderCurrentReport
    };
    renderers[pageKey]?.();
}

function toggleFormPanel(button) {
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    const isExpanded = button.getAttribute('aria-expanded') === 'true';

    button.setAttribute('aria-expanded', String(!isExpanded));
    panel.setAttribute('aria-hidden', String(isExpanded));
    panel.inert = isExpanded;

    if (isExpanded) {
        panel.style.maxHeight = `${panel.getBoundingClientRect().height}px`;
        panel.offsetHeight;
        panel.style.maxHeight = '0px';
        return;
    }

    panel.style.maxHeight = '0px';
    panel.offsetHeight;
    panel.style.maxHeight = `${panel.scrollHeight}px`;
}

async function initializeAuthentication() {
    try {
        const response = await fetch('/api/auth/status');
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || 'Could not check sign-in status.');
        if (!result.authenticated || result.user.forcePasswordChange) return window.location.replace('/login.html');
        authState = { ...result.user, isOwner: result.isOwner };
        await enterApplication();
    } catch (error) {
        console.error('[Authentication] Could not verify the session:', error);
        window.location.replace('/login.html');
    }
}

async function signOut() {
    if (liveEvents) {
        liveEvents.close();
        liveEvents = null;
    }
    try { await fetch('/api/auth/logout', { method: 'POST' }); }
    catch (error) { console.error('[Authentication] Sign-out request failed:', error); }
    finally { window.location.replace('/login.html'); }
}

async function handleExpiredSession() {
    authState = null;
    allItems = [];
    allRequests = [];
    allEquipment = [];
    allEquipmentLogs = [];
    allJobs = [];
    latestReportData = null;
    if (liveEvents) {
        liveEvents.close();
        liveEvents = null;
    }
    window.location.replace('/login.html');
}

function hasPermission(permission) {
    return authState?.isOwner === true || authState?.permissions?.[permission] === true;
}

async function enterApplication() {
    document.getElementById('signedInUser').textContent = `${authState.username} · ${authState.role}`;
    applyAccessControls();
    document.body.classList.remove('app-pending');

    if (hasPermission('consumablesView')) await fetchConsumableData();
    if (hasPermission('equipmentView')) {
        await fetchEquipmentData();
        await fetchAssetRegister();
    }
    await fetchJobs();
    const defaultTab = hasPermission('consumablesView') ? 'consumables'
        : hasPermission('equipmentView') ? 'equipment'
            : hasPermission('analyticsView') ? 'analytics' : 'jobs';
    switchTab(defaultTab);
    if (!liveEvents) connectLiveUpdates();
}

function applyAccessControls() {
    document.getElementById('tab-consumables').classList.toggle('hidden', !hasPermission('consumablesView'));
    document.getElementById('tab-equipment').classList.toggle('hidden', !hasPermission('equipmentView'));
    document.getElementById('tab-asset-register').classList.toggle('hidden', !hasPermission('equipmentView'));
    document.getElementById('addAssetRegisterRecordButton').classList.toggle('hidden', !hasPermission('equipmentManage'));
    document.getElementById('tab-analytics').classList.toggle('hidden', !hasPermission('analyticsView'));
    document.getElementById('tab-users').classList.toggle('hidden', !authState.isOwner);
    document.getElementById('addItemPanel').closest('.form-toggle').classList.toggle('hidden', !hasPermission('consumablesAdd'));
    document.getElementById('requestPanel').closest('.form-toggle').classList.toggle('hidden', !hasPermission('consumablesRequest'));
    document.getElementById('addEquipmentPanel').closest('.form-toggle').classList.toggle('hidden', !hasPermission('equipmentAdd'));
    ['checkoutEquipmentPanel', 'returnEquipmentPanel'].forEach(id => {
        document.getElementById(id).closest('.form-toggle').classList.toggle('hidden', !hasPermission('equipmentManage'));
    });
    document.getElementById('editEquipmentDialog').querySelector('form').classList.toggle('hidden', !hasPermission('equipmentManage'));
    document.getElementById('inventoryTableBody').closest('table').querySelector('th:last-child')
        .classList.toggle('hidden', !hasPermission('consumablesStockManage'));
    document.getElementById('equipmentTableBody').closest('table').querySelector('th:last-child')
        .classList.toggle('hidden', !hasPermission('equipmentManage'));
    renderInventory();
    renderEquipment();
}

function showTemporaryPassword(password) {
    document.getElementById('temporaryPasswordText').textContent = password;
    document.getElementById('temporaryPasswordResult').classList.remove('hidden');
    document.getElementById('temporaryPasswordResult').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function copyTemporaryPassword() {
    const password = document.getElementById('temporaryPasswordText').textContent;
    try {
        await navigator.clipboard.writeText(password);
        alert('Temporary password copied.');
    } catch {
        alert('Clipboard access is unavailable. Select and copy the temporary password shown above.');
    }
}

function permissionValues(form) {
    return Object.fromEntries(PERMISSION_KEYS.map(key => [key, form.elements[key].checked]));
}

const PERMISSION_KEYS = [
    'consumablesView', 'consumablesRequest', 'consumablesAdd', 'consumablesStockManage',
    'equipmentView', 'equipmentAdd', 'equipmentManage', 'analyticsView'
];

function updateCreatePermissionVisibility() {
    const form = document.getElementById('userCreateForm');
    const custom = form.elements.role.value === 'custom';
    document.getElementById('newUserPermissions').classList.toggle('hidden', !custom);
    if (custom) {
        form.elements.consumablesView.checked = true;
        form.elements.consumablesRequest.checked = true;
    }
}

function updateEditPermissionVisibility() {
    const form = document.getElementById('userEditForm');
    const custom = form.elements.role.value === 'custom';
    form.querySelector('.user-permission-grid').classList.toggle('hidden', !custom);
}

async function loadUsers() {
    const response = await fetch('/api/users');
    const users = await response.json();
    if (!response.ok || !Array.isArray(users)) throw new Error(users.message || 'Unable to load users.');
    usersCache = users;
    renderUsers();
}

async function sendTelegramReportsNow() {
    if (!authState?.isOwner) return;
    const button = document.getElementById('sendTelegramReportsButton');
    const status = document.getElementById('telegramReportStatus');
    button.disabled = true;
    status.classList.remove('text-red-600');
    status.textContent = 'Sending reports to configured Telegram chats…';
    try {
        const response = await fetch('/api/telegram/reports/send', { method: 'POST' });
        const result = await response.json();
        if (response.status === 401) {
            await handleExpiredSession();
            return;
        }
        if (!response.ok || !result.success) throw new Error(result.message || 'Could not send Telegram reports.');
        status.textContent = result.message;
    } catch (error) {
        console.error('[Telegram] Could not send reports manually:', error);
        status.textContent = error.message || 'Could not send Telegram reports.';
        status.classList.add('text-red-600');
    } finally {
        button.disabled = false;
    }
}

async function loadTelegramSettings() {
    if (!authState?.isOwner) return;
    const status = document.getElementById('telegramSettingsStatus');
    status.classList.remove('text-red-600');
    status.textContent = 'Loading Telegram settings…';
    try {
        const response = await fetch('/api/telegram/settings');
        const settings = await response.json();
        if (response.status === 401) {
            await handleExpiredSession();
            return;
        }
        if (!response.ok || !settings || typeof settings !== 'object') {
            throw new Error(settings?.message || 'Could not load Telegram settings.');
        }
        const form = document.getElementById('telegramSettingsForm');
        Object.keys(settings).forEach(key => {
            if (form.elements.namedItem(key)) form.elements.namedItem(key).value = settings[key];
        });
        status.textContent = '';
    } catch (error) {
        console.error('[Telegram] Could not load settings:', error);
        status.textContent = error.message || 'Could not load Telegram settings.';
        status.classList.add('text-red-600');
    }
}

async function saveTelegramSettings(event) {
    event.preventDefault();
    if (!authState?.isOwner) return;
    const form = event.target;
    const button = document.getElementById('saveTelegramSettingsButton');
    const status = document.getElementById('telegramSettingsStatus');
    button.disabled = true;
    status.classList.remove('text-red-600');
    status.textContent = 'Saving Telegram settings…';
    try {
        const response = await fetch('/api/telegram/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
        });
        const result = await response.json();
        if (response.status === 401) {
            await handleExpiredSession();
            return;
        }
        if (!response.ok || !result.success) throw new Error(result.message || 'Could not save Telegram settings.');
        status.textContent = 'Telegram responses and templates saved.';
    } catch (error) {
        console.error('[Telegram] Could not save settings:', error);
        status.textContent = error.message || 'Could not save Telegram settings.';
        status.classList.add('text-red-600');
    } finally {
        button.disabled = false;
    }
}

function renderUsers() {
    const tbody = document.getElementById('userTableBody');
    tbody.innerHTML = '';
    usersCache.forEach(user => {
        const isOwner = user.role === 'owner';
        const profile = user.role === 'admin' ? 'Administrator'
            : user.role === 'owner' ? 'Owner'
                : user.role === 'custom' ? 'Custom access' : 'Regular user';
        const details = user.role === 'custom'
            ? PERMISSION_KEYS.filter(key => user.permissions[key]).join(', ') || 'No app access'
            : user.role === 'user' ? 'Consumables view and requests' : 'All app features';
        const status = `${user.active ? 'Active' : 'Disabled'}${user.forcePasswordChange ? ' · Password change required' : ''}`;
        const actions = isOwner ? 'Owner account' : `
            <div class="flex flex-wrap justify-center gap-2">
                <button type="button" data-user-action="edit" data-user-id="${escapeHtml(user.id)}" class="rounded border px-2 py-1 text-xs hover:bg-gray-50">Edit access</button>
                <button type="button" data-user-action="reset" data-user-id="${escapeHtml(user.id)}" class="rounded border px-2 py-1 text-xs hover:bg-gray-50">Reset password</button>
                <button type="button" data-user-action="toggle" data-user-id="${escapeHtml(user.id)}" class="rounded border px-2 py-1 text-xs hover:bg-gray-50">${user.active ? 'Disable' : 'Enable'}</button>
            </div>`;
        tbody.innerHTML += `<tr>
            <td class="border p-2 font-medium">${escapeHtml(user.username)}</td>
            <td class="border p-2"><strong>${profile}</strong><br><span class="text-xs text-gray-500">${escapeHtml(details)}</span></td>
            <td class="border p-2 text-center">${escapeHtml(status)}</td>
            <td class="border p-2 text-center">${actions}</td>
        </tr>`;
    });
}

async function createUser(event) {
    event.preventDefault();
    const form = event.target;
    const role = form.elements.role.value;
    const payload = { username: form.elements.username.value.trim(), role };
    if (role === 'custom') payload.permissions = permissionValues(form);
    const response = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || !result.success) return alert(result.message || 'Could not create account.');
    form.reset();
    updateCreatePermissionVisibility();
    showTemporaryPassword(result.temporaryPassword);
    await loadUsers();
}

async function handleUserAction(event) {
    const button = event.target.closest('[data-user-action]');
    if (!button) return;
    const user = usersCache.find(entry => entry.id === button.dataset.userId);
    if (!user) return;
    if (button.dataset.userAction === 'edit') {
        const form = document.getElementById('userEditForm');
        form.elements.userId.value = user.id;
        form.elements.role.value = user.role;
        PERMISSION_KEYS.forEach(key => { form.elements[key].checked = user.permissions[key] === true; });
        updateEditPermissionVisibility();
        document.getElementById('userEditDialog').showModal();
    } else if (button.dataset.userAction === 'reset') {
        if (!confirm(`Issue a temporary password for ${user.username}? Their current sessions will be signed out.`)) return;
        const response = await fetch(`/api/users/${encodeURIComponent(user.id)}/reset-password`, { method: 'POST' });
        const result = await response.json();
        if (!response.ok || !result.success) return alert(result.message || 'Could not reset password.');
        showTemporaryPassword(result.temporaryPassword);
        await loadUsers();
    } else if (button.dataset.userAction === 'toggle') {
        const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: user.role, active: !user.active, permissions: user.permissions })
        });
        const result = await response.json();
        if (!response.ok || !result.success) return alert(result.message || 'Could not update account.');
        await loadUsers();
    }
}

async function saveUserAccess(event) {
    event.preventDefault();
    const form = event.target;
    const user = usersCache.find(entry => entry.id === form.elements.userId.value);
    if (!user) return alert('User not found.');
    const role = form.elements.role.value;
    const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            role,
            active: user.active,
            permissions: role === 'custom' ? permissionValues(form) : user.permissions
        })
    });
    const result = await response.json();
    if (!response.ok || !result.success) return alert(result.message || 'Could not update user access.');
    document.getElementById('userEditDialog').close();
    await loadUsers();
}

// ============================================================
//  TAB SWITCHING
// ============================================================

function switchTab(tabName) {
    const allowed = {
        consumables: hasPermission('consumablesView'),
        equipment: hasPermission('equipmentView'),
        'asset-register': hasPermission('equipmentView'),
        jobs: authState !== null,
        analytics: hasPermission('analyticsView'),
        users: authState?.isOwner === true
    };
    if (!allowed[tabName]) return;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.getElementById('tab-' + tabName).classList.add('active');
    document.getElementById('content-' + tabName).classList.add('active');
    if (tabName === 'users') {
        loadUsers().catch(error => alert(error.message));
        loadTelegramSettings();
    }
}

// ============================================================
//  WORKBOOK-BASED ASSET REGISTER
// ============================================================

let assetRegisterData = null;
let activeAssetRegisterTab = 'devices';
let assetRegisterSort = { key: 'location', direction: 'asc' };

async function fetchAssetRegister() {
    const status = document.getElementById('assetRegisterLoadStatus');
    status.classList.remove('text-red-600');
    status.textContent = 'Loading asset register…';

    try {
        const response = await fetch('/api/asset-register');
        if (response.status === 401) {
            await handleExpiredSession();
            return;
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Failed to load the asset register.');
        if (!data || !Array.isArray(data.tabs) || data.tabs.length === 0) {
            throw new Error('The asset register workbook contains no inventory tabs.');
        }

        assetRegisterData = data;
        document.getElementById('assetRegisterSite').textContent = data.siteName || '';
        document.getElementById('assetRegisterPreparedDate').textContent =
            data.datePrepared ? `Date prepared: ${data.datePrepared}` : '';
        document.getElementById('assetRegisterPrintBusinessUnit').textContent = data.businessUnit || '';
        document.getElementById('assetRegisterPrintSite').textContent = data.siteName || '';
        document.getElementById('assetRegisterPrintDate').textContent =
            data.datePrepared ? `Date prepared: ${data.datePrepared}` : '';

        renderAssetRegisterSummary();
        renderAssetRegisterNavigation();
        populateAssetRegisterTypeFilter();
        document.getElementById('assetRegisterContent').classList.remove('hidden');
        status.textContent = '';
        const activeTab = data.tabs.find(item => item.id === activeAssetRegisterTab) || data.tabs[0];
        activeAssetRegisterTab = activeTab.id;
        document.getElementById('assetRegisterPrintTitle').textContent = `${activeTab.title} Asset Inventory`;
        renderAssetRegisterNavigation();
        renderAssetRegister();
    } catch (error) {
        console.error('[Asset register] Could not load the workbook inventory:', error);
        status.textContent = `Unable to load the asset register: ${error.message}`;
        status.classList.add('text-red-600');
    }
}

function renderAssetRegisterSummary() {
    const summary = document.getElementById('assetRegisterSummary');
    summary.innerHTML = assetRegisterData.tabs.map(tab => `
        <div class="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p class="text-xs text-gray-500">${escapeHtml(tab.label)}</p>
            <p class="mt-1 text-xl font-semibold text-gray-800">${tab.rows.length}</p>
        </div>
    `).join('');
}

function renderAssetRegisterNavigation() {
    document.getElementById('assetRegisterNavigation').innerHTML = assetRegisterData.tabs.map(tab => `
        <button type="button" role="tab" data-asset-register-tab="${escapeHtml(tab.id)}"
            aria-selected="${tab.id === activeAssetRegisterTab}"
            class="asset-register-tab rounded border px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 ${tab.id === activeAssetRegisterTab ? 'active' : ''}">
            ${escapeHtml(tab.label)} <span class="ml-1 text-xs">(${tab.rows.length})</span>
        </button>
    `).join('');
}

function populateAssetRegisterTypeFilter() {
    const select = document.getElementById('assetRegisterTypeFilter');
    const selectedType = select.value;
    const devices = assetRegisterData.tabs.find(tab => tab.id === 'devices');
    const types = [...new Set((devices?.rows || []).map(row => row.type).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="">All device types</option>' +
        types.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
    if (types.includes(selectedType)) select.value = selectedType;
}

function switchAssetRegisterTab(tabId) {
    const tab = assetRegisterData?.tabs.find(item => item.id === tabId);
    if (!tab) return;
    activeAssetRegisterTab = tabId;
    assetRegisterSort = { key: 'location', direction: 'asc' };
    document.getElementById('assetRegisterSearch').value = '';
    document.getElementById('assetRegisterTypeFilter').value = '';
    document.getElementById('assetRegisterTypeFilter').classList.toggle('hidden', tab.id !== 'devices');
    renderAssetRegisterNavigation();
    document.getElementById('assetRegisterPrintTitle').textContent = `${tab.title} Asset Inventory`;
    renderAssetRegister();
}

function renderAssetRegister() {
    if (!assetRegisterData) return;
    const tab = assetRegisterData.tabs.find(item => item.id === activeAssetRegisterTab);
    if (!tab) return;
    const query = document.getElementById('assetRegisterSearch').value.trim().toLowerCase();
    const type = document.getElementById('assetRegisterTypeFilter').value;
    const rows = tab.rows.filter(row => {
        const matchesQuery = !query || Object.values(row).some(value => String(value || '').toLowerCase().includes(query));
        return matchesQuery && (!type || row.type === type);
    }).sort((a, b) => {
        const comparison = String(a[assetRegisterSort.key] || '').localeCompare(
            String(b[assetRegisterSort.key] || ''),
            undefined,
            { numeric: true, sensitivity: 'base' }
        );
        return assetRegisterSort.direction === 'asc' ? comparison : -comparison;
    });
    document.getElementById('assetRegisterResultCount').textContent =
        `Showing ${rows.length} of ${tab.rows.length} ${tab.rows.length === 1 ? 'record' : 'records'} · Sorted by ${tab.columns.find(column => column.key === assetRegisterSort.key)?.label || 'Location'} (${assetRegisterSort.direction === 'asc' ? 'A–Z' : 'Z–A'})`;

    const headings = tab.columns.map(column => {
        const isSorted = column.key === assetRegisterSort.key;
        const direction = isSorted ? assetRegisterSort.direction : 'asc';
        const indicator = isSorted ? (direction === 'asc' ? '↑' : '↓') : '↕';
        return `<th scope="col" class="border border-gray-300 bg-gray-100 p-2 text-left">
            <span>${escapeHtml(column.label)}</span>
            <button type="button" class="no-print ml-1 text-gray-500 hover:text-teal-700" data-asset-register-sort="${escapeHtml(column.key)}" aria-label="Sort by ${escapeHtml(column.label)}, ${direction === 'asc' ? 'ascending' : 'descending'}">
                <span aria-hidden="true">${indicator}</span>
            </button>
        </th>`;
    }).join('');
    const canManage = hasPermission('equipmentManage');
    const body = rows.length
        ? rows.map(row => {
            const rowStatus = String(row.assetStatus || 'Good').toLowerCase();
            const rowClass = rowStatus === 'good'
                ? 'asset-register-row-good'
                : rowStatus === 'under maintenance'
                    ? 'asset-register-row-maintenance'
                    : 'asset-register-row-alert';
            return `<tr class="${rowClass}">${tab.columns.map(column => {
                const value = row[column.key] || '—';
                const statusClass = column.key === 'assetStatus' ? 'asset-register-status' : '';
                return `<td class="border border-gray-300 p-2 align-top ${statusClass}">${escapeHtml(value)}</td>`;
            }).join('')}${canManage ? `<td class="no-print border border-gray-300 p-2 text-center"><div class="flex justify-center gap-1"><button type="button" data-asset-register-action="edit" data-record-id="${escapeHtml(row.id)}" class="rounded border px-2 py-1 text-xs text-teal-800 hover:bg-teal-50" aria-label="Edit asset record">Edit</button><button type="button" data-asset-register-action="delete" data-record-id="${escapeHtml(row.id)}" class="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50" aria-label="Delete asset record">Delete</button></div></td>` : ''}</tr>`;
        }).join('')
        : `<tr><td colspan="${tab.columns.length + (canManage ? 1 : 0)}" class="border border-gray-300 p-5 text-center text-gray-500">No matching records.</td></tr>`;

    document.getElementById('assetRegisterPanels').innerHTML = `
        <section class="asset-register-panel active" role="tabpanel">
            <h3 class="mb-3 text-lg font-semibold text-gray-700">${escapeHtml(tab.title)} Inventory</h3>
            <div class="overflow-x-auto">
                <table class="asset-register-table w-full border-collapse border border-gray-300 text-sm">
                    <thead><tr>${headings}${canManage ? '<th scope="col" class="no-print border border-gray-300 bg-gray-100 p-2 text-center">Actions</th>' : ''}</tr></thead>
                    <tbody>${body}</tbody>
                </table>
            </div>
        </section>`;
}

function handleAssetRegisterAction(event) {
    const sortButton = event.target.closest('[data-asset-register-sort]');
    if (sortButton) {
        const key = sortButton.dataset.assetRegisterSort;
        if (assetRegisterSort.key === key) {
            assetRegisterSort.direction = assetRegisterSort.direction === 'asc' ? 'desc' : 'asc';
        } else {
            assetRegisterSort = { key, direction: 'asc' };
        }
        renderAssetRegister();
        return;
    }
    const button = event.target.closest('[data-asset-register-action="edit"]');
    if (button) return openAssetRegisterEditor(button.dataset.recordId);
    const deleteButton = event.target.closest('[data-asset-register-action="delete"]');
    if (deleteButton) deleteAssetRegisterRecord(deleteButton.dataset.recordId);
}

async function deleteAssetRegisterRecord(recordId) {
    if (!hasPermission('equipmentManage')) return;
    const tab = assetRegisterData?.tabs.find(item => item.id === activeAssetRegisterTab);
    const record = tab?.rows.find(item => item.id === recordId);
    if (!tab || !record) return alert('Asset register record not found.');

    const description = record.type || record.model || record.description || tab.title;
    const location = record.location ? ` at ${record.location}` : '';
    if (!confirm(`Delete ${description}${location} from the asset register? This cannot be undone.`)) return;

    try {
        const response = await fetch(
            `/api/asset-register/${encodeURIComponent(tab.id)}/rows/${encodeURIComponent(recordId)}`,
            { method: 'DELETE' }
        );
        const result = await response.json();
        if (!response.ok || !result.success) return alert(result.message || 'Failed to delete the asset register record.');
        await fetchAssetRegister();
    } catch (error) {
        console.error('[Asset register] Could not delete the record:', error);
        alert('Could not delete the asset register record. Please try again.');
    }
}

function openAssetRegisterEditor(recordId = '') {
    if (!hasPermission('equipmentManage')) return;
    const tab = assetRegisterData?.tabs.find(item => item.id === activeAssetRegisterTab);
    if (!tab) return;
    const record = recordId ? tab.rows.find(item => item.id === recordId) : null;
    if (recordId && !record) return alert('Asset register record not found.');

    const form = document.getElementById('assetRegisterRecordForm');
    form.elements.namedItem('recordId').value = record?.id || '';
    document.getElementById('assetRegisterRecordDialogTitle').textContent =
        `${record ? 'Edit' : 'Add'} ${tab.title} Record`;
    document.getElementById('assetRegisterRecordFields').innerHTML = tab.columns.map(column => {
        const required = column.key === 'location' || (tab.id === 'devices' && column.key === 'type');
        const value = escapeHtml(record?.[column.key] || '');
        const control = column.key === 'assetStatus'
            ? `<select id="asset-register-${escapeHtml(column.key)}" name="${escapeHtml(column.key)}" class="mt-1 w-full rounded border p-2" required>
                ${['Good', 'Under Maintenance', 'Needs Repair', 'Not Working'].map(status =>
                    `<option value="${status}" ${record?.[column.key] === status ? 'selected' : ''}>${status}</option>`
                ).join('')}
            </select>`
            : column.key === 'description'
                ? `<textarea id="asset-register-${escapeHtml(column.key)}" name="${escapeHtml(column.key)}" maxlength="1000" rows="3" class="mt-1 w-full rounded border p-2">${value}</textarea>`
                : `<input id="asset-register-${escapeHtml(column.key)}" name="${escapeHtml(column.key)}" type="text" maxlength="1000" value="${value}" class="mt-1 w-full rounded border p-2" ${required ? 'required' : ''}>`;
        return `<label for="asset-register-${escapeHtml(column.key)}" class="block text-sm text-gray-700">${escapeHtml(column.label)}${required ? ' <span aria-hidden="true">*</span>' : ''}${control}</label>`;
    }).join('');
    document.getElementById('assetRegisterRecordDialog').showModal();
}

function closeAssetRegisterEditor() {
    document.getElementById('assetRegisterRecordDialog').close();
}

async function saveAssetRegisterRecord(event) {
    event.preventDefault();
    const tab = assetRegisterData?.tabs.find(item => item.id === activeAssetRegisterTab);
    if (!tab || !hasPermission('equipmentManage')) return;
    const form = event.target;
    const recordId = form.elements.namedItem('recordId').value;
    const row = Object.fromEntries(tab.columns.map(column => [
        column.key,
        form.elements.namedItem(column.key).value
    ]));
    const endpoint = `/api/asset-register/${encodeURIComponent(tab.id)}/rows` +
        (recordId ? `/${encodeURIComponent(recordId)}` : '');
    try {
        const response = await fetch(endpoint, {
            method: recordId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ row })
        });
        const result = await response.json();
        if (!response.ok || !result.success) return alert(result.message || 'Failed to save the asset register record.');
        closeAssetRegisterEditor();
        await fetchAssetRegister();
    } catch (error) {
        console.error('[Asset register] Could not save the record:', error);
        alert('Could not save the asset register record. Please try again.');
    }
}

function printAssetRegister() {
    if (!assetRegisterData) return;
    document.body.classList.add('printing-asset-register');
    window.print();
}

// ============================================================
//  IT JOBS
// ============================================================

let allJobs = [];

async function fetchJobs() {
    const response = await fetch('/api/jobs');
    const jobs = await response.json();
    if (response.status === 401) {
        await handleExpiredSession();
        throw new Error('Your session has ended. Please sign in again.');
    }
    if (!response.ok || !Array.isArray(jobs)) throw new Error(jobs.message || 'Failed to load IT jobs.');
    allJobs = jobs;
    renderJobs();
}

function isJobManager() {
    return authState?.role === 'owner' || authState?.role === 'admin';
}

function isJobOverdue(job, today = toDateInputValue(new Date())) {
    return !['Completed', 'Cancelled'].includes(job.status) && job.followUpDate < today;
}

function renderJobs() {
    const tbody = document.getElementById('jobTableBody');
    const today = toDateInputValue(new Date());
    const activeJobs = allJobs.filter(job => !['Completed', 'Cancelled'].includes(job.status));
    const overdueCount = activeJobs.filter(job => isJobOverdue(job, today)).length;
    const statusCounts = Object.fromEntries(JOB_STATUSES.map(status => [
        status, allJobs.filter(job => job.status === status).length
    ]));
    document.getElementById('jobSummary').innerHTML = `
        <span class="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">Total: ${allJobs.length}</span>
        <span class="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">Pending: ${statusCounts.Pending}</span>
        <span class="rounded-full bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-800">In progress: ${statusCounts['In Progress']}</span>
        <span class="rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-800">Overdue: ${overdueCount}</span>`;

    const search = document.getElementById('jobSearch').value.trim().toLowerCase();
    const statusFilter = document.getElementById('jobStatusFilter').value;
    const jobs = allJobs.filter(job => {
        const searchable = [job.title, job.description, job.requestedBy, job.department, job.assignedTo]
            .some(value => String(value || '').toLowerCase().includes(search));
        const matchesStatus = !statusFilter ||
            (statusFilter === 'overdue' ? isJobOverdue(job, today) : job.status === statusFilter);
        return searchable && matchesStatus;
    }).sort((a, b) => (b.dateFiled || '').localeCompare(a.dateFiled || '') ||
        (b.createdAt || '').localeCompare(a.createdAt || ''));

    tbody.innerHTML = '';
    document.getElementById('jobEmptyState').classList.toggle('hidden', jobs.length > 0);
    document.getElementById('jobActionsHeader').classList.toggle('hidden', !isJobManager());
    jobs.forEach(job => {
        const latestUpdate = Array.isArray(job.statusHistory) ? job.statusHistory[job.statusHistory.length - 1] : null;
        const overdue = isJobOverdue(job, today);
        const statusColors = {
            Pending: 'bg-amber-100 text-amber-800',
            'In Progress': 'bg-blue-100 text-blue-800',
            'Waiting on Requester': 'bg-purple-100 text-purple-800',
            'On Hold': 'bg-gray-200 text-gray-800',
            Completed: 'bg-green-100 text-green-800',
            Cancelled: 'bg-red-100 text-red-800'
        };
        const statusClass = statusColors[job.status] || 'bg-gray-100 text-gray-700';
        const updateDetails = latestUpdate
            ? `<span class="block text-xs text-gray-500">${escapeHtml(latestUpdate.changedAt ? new Date(latestUpdate.changedAt).toLocaleString() : '')} · ${escapeHtml(latestUpdate.changedBy || job.requestedBy || 'Unknown')}</span>
                ${latestUpdate.note ? `<span class="mt-1 block whitespace-pre-line text-xs text-gray-600">${escapeHtml(latestUpdate.note)}</span>` : ''}`
            : '';
        tbody.innerHTML += `<tr>
            <td class="border p-2 align-top">
                <strong>${escapeHtml(job.title)}</strong>
                <p class="mt-1 max-w-md whitespace-pre-line text-xs text-gray-600">${escapeHtml(job.description)}</p>
            </td>
            <td class="border p-2 align-top">${escapeHtml(job.requestedBy || 'Not recorded')}
                ${job.department ? `<span class="block text-xs text-gray-500">${escapeHtml(job.department)}</span>` : ''}
            </td>
            <td class="border p-2 align-top">${escapeHtml(job.category)}
                <span class="mt-1 block text-xs font-semibold ${job.priority === 'Urgent' ? 'text-red-700' : job.priority === 'High' ? 'text-orange-700' : 'text-gray-600'}">${escapeHtml(job.priority)}</span>
            </td>
            <td class="border p-2 text-center align-top">${formatDateOnly(job.dateFiled)}</td>
            <td class="border p-2 text-center align-top ${overdue ? 'font-semibold text-red-700' : ''}">${formatDateOnly(job.followUpDate)}${overdue ? '<span class="block text-xs">Overdue</span>' : ''}</td>
            <td class="border p-2 align-top">${escapeHtml(job.assignedTo || 'Unassigned')}</td>
            <td class="border p-2 align-top">
                <span class="rounded-full px-2 py-1 text-xs font-semibold ${statusClass}">${escapeHtml(job.status || 'Pending')}</span>
                ${updateDetails}
            </td>
            <td class="border p-2 text-center align-top no-print ${isJobManager() ? '' : 'hidden'}">
                <button type="button" data-job-action="status" data-job-id="${escapeHtml(job.id)}" class="whitespace-nowrap rounded border px-2 py-1 text-xs hover:bg-gray-50">Update status</button>
            </td>
        </tr>`;
    });
}

function handleJobAction(event) {
    const button = event.target.closest('[data-job-action="status"]');
    if (!button || !isJobManager()) return;
    const job = allJobs.find(entry => entry.id === button.dataset.jobId);
    if (!job) return;
    const form = document.getElementById('jobStatusForm');
    form.elements.jobId.value = job.id;
    form.elements.status.value = job.status || 'Pending';
    form.elements.note.value = '';
    document.getElementById('jobStatusTitle').textContent = job.title;
    document.getElementById('jobStatusDialog').showModal();
}

async function fileNewJob(event) {
    event.preventDefault();
    const form = event.target;
    const payload = Object.fromEntries(new FormData(form).entries());
    try {
        const response = await fetch('/api/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok || !result.success) return alert(result.message || 'Could not file the IT job.');
        form.reset();
        const followUpDate = new Date();
        followUpDate.setDate(followUpDate.getDate() + 7);
        form.elements.followUpDate.value = toDateInputValue(followUpDate);
        const panelButton = document.querySelector('#addJobPanel').previousElementSibling;
        if (panelButton.getAttribute('aria-expanded') === 'true') toggleFormPanel(panelButton);
        await fetchJobs();
    } catch (error) {
        console.error('[IT jobs] Could not file the job:', error);
        alert('Could not file the IT job. Check your connection and try again.');
    }
}

async function saveJobStatus(event) {
    event.preventDefault();
    if (!isJobManager()) return alert('Only the owner or an administrator can change job status.');
    const form = event.target;
    try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(form.elements.jobId.value)}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: form.elements.status.value, note: form.elements.note.value })
        });
        const result = await response.json();
        if (!response.ok || !result.success) return alert(result.message || 'Could not update the IT job status.');
        document.getElementById('jobStatusDialog').close();
        await fetchJobs();
    } catch (error) {
        console.error('[IT jobs] Could not update job status:', error);
        alert('Could not update the IT job status. Check your connection and try again.');
    }
}

// ============================================================
//  CONSUMABLES
// ============================================================

let allItems = [];
let allRequests = [];
let allStockLogs = [];

async function fetchConsumableData() {
    const response = await fetch('/api/data');
    const data = await response.json();
    if (response.status === 401) {
        await handleExpiredSession();
        throw new Error('Your session has ended. Please sign in again.');
    }
    if (!response.ok || !Array.isArray(data.items)) throw new Error(data.message || 'Failed to load consumables.');
    allItems = data.items;
    allRequests = data.requests;
    allStockLogs = Array.isArray(data.stockLogs) ? data.stockLogs : [];
    updateFilterOptions('inventoryCategoryFilter', allItems.map(item => item.category));
    renderInventory();
    updateItemSelect(data.items);
    renderRequests();
    renderStockActivity();
}

function updateFilterOptions(elementId, values) {
    const select = document.getElementById(elementId);
    const selected = select.value;
    const firstOption = select.options[0].outerHTML;
    const options = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
    select.innerHTML = firstOption + options.map(value =>
        `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`
    ).join('');
    if (options.includes(selected)) select.value = selected;
}

function renderInventory() {
    const lowStockCount = allItems.filter(item => item.quantity <= (item.lowStockThreshold ?? 5)).length;
    document.getElementById('inventoryAlertSummary').textContent = lowStockCount
        ? `${lowStockCount} item${lowStockCount === 1 ? '' : 's'} at or below the low-stock threshold.`
        : 'All items are above their low-stock thresholds.';
    const query = document.getElementById('inventorySearch').value.trim().toLowerCase();
    const category = document.getElementById('inventoryCategoryFilter').value;
    const stockFilter = document.getElementById('inventoryStockFilter').value;
    const sort = document.getElementById('inventorySort').value;
    const items = allItems.filter(item => {
        const lowStock = item.quantity > 0 && item.quantity <= (item.lowStockThreshold ?? 5);
        return (!query || `${item.name} ${item.category}`.toLowerCase().includes(query)) &&
            (!category || item.category === category) &&
            (stockFilter === 'all' || (stockFilter === 'low' && lowStock) ||
                (stockFilter === 'out' && item.quantity === 0));
    }).sort((a, b) => {
        if (sort === 'quantity-asc') return a.quantity - b.quantity;
        if (sort === 'quantity-desc') return b.quantity - a.quantity;
        if (sort === 'category') return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
        return a.name.localeCompare(b.name);
    });
    updateInventoryTable(items);
}

function updateInventoryTable(items) {
    const tbody = document.getElementById('inventoryTableBody');
    const canManageStock = hasPermission('consumablesStockManage');
    tbody.innerHTML = '';
    if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${canManageStock ? 7 : 6}" class="border p-4 text-center text-gray-400">${allItems.length ? 'No consumables match your filters.' : 'No items yet. Add your first consumable above.'}</td></tr>`;
        return;
    }
    items.forEach(item => {
        const photoHtml = item.photo ? `<img src="${escapeHtml(item.photo)}" class="w-14 h-14 object-cover rounded mx-auto">` : '<span class="text-gray-300">No Image</span>';
        const threshold = item.lowStockThreshold ?? 5;
        const stockClass = item.quantity <= 0 ? 'text-red-600' : item.quantity <= threshold ? 'text-orange-500' : 'text-green-600';
        const stockStatus = item.quantity <= 0
            ? '<span class="font-semibold text-red-600">Out of stock</span>'
            : item.quantity <= threshold
                ? '<span class="font-semibold text-orange-600">Low</span>'
                : '<span class="text-green-700">OK</span>';
        tbody.innerHTML += `
            <tr>
                <td class="border p-2 text-center">${photoHtml}</td>
                <td class="border p-2">${escapeHtml(item.name)}</td>
                <td class="border p-2">${escapeHtml(item.category)}</td>
                <td class="border p-2">${escapeHtml(item.createdBy || 'Not recorded')}</td>
                <td class="border p-2 text-center font-bold ${stockClass}">${item.quantity}</td>
                <td class="border p-2 text-center">${stockStatus} <span class="text-xs text-gray-500">(${threshold})</span></td>
                <td class="border p-2 text-center no-print ${canManageStock ? '' : 'hidden'}">
                    <div class="flex flex-wrap justify-center gap-1">
                        ${canManageStock ? `
                            <button type="button" data-stock-action="restock" data-item-id="${escapeHtml(item.id)}" class="rounded bg-teal-50 px-2 py-1 text-xs text-teal-800 hover:bg-teal-100">Restock</button>
                            <button type="button" data-stock-action="adjust" data-item-id="${escapeHtml(item.id)}" class="rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 hover:bg-gray-200">Adjust</button>
                            <button type="button" data-stock-action="threshold" data-item-id="${escapeHtml(item.id)}" class="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 hover:bg-amber-100">Alert</button>
                        ` : ''}
                    </div>
                </td>
            </tr>
        `;
    });
}

function handleStockAction(event) {
    const button = event.target.closest('[data-stock-action]');
    if (!button) return;
    const actions = {
        restock: restockItem,
        adjust: adjustItemStock,
        threshold: setLowStockThreshold
    };
    actions[button.dataset.stockAction]?.(button.dataset.itemId);
}

async function submitStockAdjustment(item, adjustment, threshold = item.lowStockThreshold ?? 5) {
    const response = await fetch(`/api/items/${encodeURIComponent(item.id)}/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adjustment, lowStockThreshold: threshold })
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || 'Stock update failed.');
    await fetchConsumableData();
}

async function restockItem(id) {
    const item = allItems.find(entry => entry.id === id);
    if (!item) return alert('Consumable not found.');
    const amount = prompt(`How many units of ${item.name} are being added?`);
    if (amount === null) return;
    const quantity = Number(amount);
    if (!Number.isInteger(quantity) || quantity <= 0) return alert('Enter a whole number greater than zero.');
    try { await submitStockAdjustment(item, quantity); }
    catch (error) { alert(error.message); }
}

async function adjustItemStock(id) {
    const item = allItems.find(entry => entry.id === id);
    if (!item) return alert('Consumable not found.');
    const amount = prompt('Enter a whole-number stock adjustment. Use a negative number to remove stock.', '0');
    if (amount === null) return;
    const adjustment = Number(amount);
    if (!Number.isInteger(adjustment) || adjustment === 0) return alert('Enter a non-zero whole number.');
    try { await submitStockAdjustment(item, adjustment); }
    catch (error) { alert(error.message); }
}

async function setLowStockThreshold(id) {
    const item = allItems.find(entry => entry.id === id);
    if (!item) return alert('Consumable not found.');
    const amount = prompt(`Alert when ${item.name} reaches this quantity or lower:`, String(item.lowStockThreshold ?? 5));
    if (amount === null) return;
    const threshold = Number(amount);
    if (!Number.isInteger(threshold) || threshold < 0) return alert('Enter a non-negative whole number.');
    try { await submitStockAdjustment(item, 0, threshold); }
    catch (error) { alert(error.message); }
}

function updateItemSelect(items) {
    const select = document.getElementById('itemSelect');
    select.innerHTML = '<option value="">-- Choose Item --</option>';
    items.forEach(item => {
        if (item.quantity > 0) {
            select.innerHTML += `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} (Available: ${item.quantity})</option>`;
        }
    });
}

function renderRequests() {
    const query = document.getElementById('requestSearch').value.trim().toLowerCase();
    const requests = allRequests.filter(request =>
        `${request.itemName} ${request.requestor} ${request.department} ${request.processedBy || ''}`.toLowerCase().includes(query)
    );
    const tbody = document.getElementById('requestTableBody');
    tbody.innerHTML = '';
    if (requests.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="border p-4 text-center text-gray-400">${allRequests.length ? 'No requests match your search.' : 'No requests logged yet.'}</td></tr>`;
        return;
    }
    requests.slice().reverse().forEach(req => {
        tbody.innerHTML += `
            <tr>
                <td class="border p-2">${new Date(req.date).toLocaleString()}</td>
                <td class="border p-2">${escapeHtml(req.itemName)}</td>
                <td class="border p-2">${escapeHtml(req.requestor)}</td>
                <td class="border p-2">${escapeHtml(req.department)}</td>
                <td class="border p-2 text-center">${req.quantity}</td>
                <td class="border p-2">${escapeHtml(req.processedBy || 'Not recorded')}</td>
            </tr>
        `;
    });
}

function renderStockActivity() {
    const tbody = document.getElementById('stockActivityTableBody');
    tbody.innerHTML = '';
    if (allStockLogs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="border p-4 text-center text-gray-400">No stock activity logged yet.</td></tr>';
        return;
    }

    allStockLogs.slice().reverse().forEach(log => {
        const actionLabels = {
            'item-added': 'Item added',
            restock: 'Restock',
            adjustment: 'Stock adjustment',
            threshold: 'Threshold updated',
            issued: 'Consumable issued'
        };
        tbody.innerHTML += `<tr>
            <td class="border p-2">${new Date(log.date).toLocaleString()}</td>
            <td class="border p-2">${escapeHtml(log.itemName)}</td>
            <td class="border p-2">${actionLabels[log.action] || escapeHtml(log.action)}</td>
            <td class="border p-2 text-center">${Number(log.quantityChange) > 0 ? '+' : ''}${Number(log.quantityChange) || 0}</td>
            <td class="border p-2">${escapeHtml(log.details || '')}</td>
            <td class="border p-2">${escapeHtml(log.processedBy || 'Not recorded')}</td>
        </tr>`;
    });
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

// Handle Add Item
document.getElementById('addItemForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const res = await fetch('/api/items', { method: 'POST', body: formData });
    const result = await res.json();
    if (!res.ok || !result.success) return alert(result.message || 'Failed to add item.');
    e.target.reset();
    e.target.elements.lowStockThreshold.value = '5';
    await fetchConsumableData();
    alert('Item added successfully!');
});

// Handle Request
document.getElementById('requestForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    const res = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    const result = await res.json();
    if (!res.ok || !result.success) return alert(result.message || 'Failed to submit request.');
    e.target.reset();
    await fetchConsumableData();
    alert('Request logged and inventory updated!');
});

// ============================================================
//  IT EQUIPMENT TRACKER
// ============================================================

let allEquipment = [];
let allEquipmentLogs = [];

async function fetchEquipmentData() {
    const [eqRes, logRes] = await Promise.all([
        fetch('/api/equipment'),
        fetch('/api/equipment/logs')
    ]);
    allEquipment = await eqRes.json();
    allEquipmentLogs = await logRes.json();
    if (eqRes.status === 401 || logRes.status === 401) {
        await handleExpiredSession();
        throw new Error('Your session has ended. Please sign in again.');
    }
    if (!eqRes.ok || !Array.isArray(allEquipment)) throw new Error('Failed to load equipment.');
    if (!logRes.ok || !Array.isArray(allEquipmentLogs)) throw new Error('Failed to load equipment activity.');

    updateFilterOptions('equipmentCategoryFilter', allEquipment.map(equipment => equipment.category));
    renderEquipment();
    updateEquipmentSelects(allEquipment);
    updateEquipmentStatusSummary(allEquipment);
    renderEquipmentLogs();
}

function updateEquipmentStatusSummary(equipment) {
    const available = equipment.filter(e => e.status === 'available').length;
    const checkedOut = equipment.filter(e => e.status === 'checked-out').length;
    const maintenance = equipment.filter(e => e.status === 'maintenance').length;
    const missing = equipment.filter(e => e.status === 'missing').length;
    const today = toDateInputValue(new Date());
    const overdue = equipment.filter(e => e.status === 'checked-out' && e.dueDate && e.dueDate < today).length;
    document.getElementById('eqStatusSummary').innerHTML = `
        <span class="px-3 py-1 rounded-full text-sm font-semibold status-available">✅ Available: ${available}</span>
        <span class="px-3 py-1 rounded-full text-sm font-semibold status-checked-out">📤 Deployed: ${checkedOut}</span>
        <span class="px-3 py-1 rounded-full text-sm font-semibold ${overdue ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600'}">⚠️ Overdue: ${overdue}</span>
        <span class="px-3 py-1 rounded-full text-sm font-semibold status-maintenance">🔧 Maintenance: ${maintenance}</span>
        <span class="px-3 py-1 rounded-full text-sm font-semibold status-missing">❓ Missing: ${missing}</span>
        <span class="px-3 py-1 rounded-full text-sm font-semibold bg-gray-100 text-gray-600">Total: ${equipment.length}</span>
    `;
}

function renderEquipment() {
    const query = document.getElementById('equipmentSearch').value.trim().toLowerCase();
    const category = document.getElementById('equipmentCategoryFilter').value;
    const status = document.getElementById('equipmentStatusFilter').value;
    const sort = document.getElementById('equipmentSort').value;
    const today = toDateInputValue(new Date());
    const equipment = allEquipment.filter(item => {
        const overdue = item.status === 'checked-out' && item.dueDate && item.dueDate < today;
        const text = `${item.name} ${item.category} ${item.serialNumber} ${item.borrower || ''} ${item.currentLocation}`.toLowerCase();
        return (!query || text.includes(query)) &&
            (!category || item.category === category) &&
            (!status || (status === 'overdue' ? overdue : item.status === status));
    }).sort((a, b) => {
        if (sort === 'category') return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
        if (sort === 'dueDate') return (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31');
        if (sort === 'location') return (a.currentLocation || '').localeCompare(b.currentLocation || '');
        return a.name.localeCompare(b.name);
    });
    updateEquipmentTable(getPageItems(equipment, 'equipment'), equipment.length);
}

function updateEquipmentTable(equipment, totalItems) {
    const tbody = document.getElementById('equipmentTableBody');
    const canManageEquipment = hasPermission('equipmentManage');
    tbody.innerHTML = '';
    renderPaginationControls('equipmentPagination', 'equipment', totalItems);
    if (equipment.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${canManageEquipment ? 11 : 10}" class="border p-4 text-center text-gray-400">${allEquipment.length ? 'No equipment matches your filters.' : 'No equipment registered yet.'}</td></tr>`;
        return;
    }
    equipment.forEach(eq => {
        const photoHtml = eq.photo ? `<img src="${escapeHtml(eq.photo)}" class="w-14 h-14 object-cover rounded mx-auto">` : '<span class="text-gray-300 text-xs">No Image</span>';
        const statusBadge = getStatusBadge(eq.status);
        const conditionBadge = getConditionBadge(eq.condition);
        const borrowerInfo = eq.borrower ? `${escapeHtml(eq.borrower)}<br><span class="text-xs text-gray-400">${escapeHtml(eq.department || '')}</span>` : '—';
        const isOverdue = eq.status === 'checked-out' && eq.dueDate && eq.dueDate < toDateInputValue(new Date());
        const dueDate = eq.dueDate
            ? `<span class="${isOverdue ? 'font-semibold text-red-600' : 'text-gray-700'}">${isOverdue ? 'Overdue · ' : ''}${formatDateOnly(eq.dueDate)}</span>`
            : '—';

        let actions = '';
        if (canManageEquipment && eq.status === 'available') {
            actions += `<button type="button" data-equipment-action="maintenance" data-equipment-id="${escapeHtml(eq.id)}" class="text-xs bg-yellow-100 text-yellow-700 px-2 py-1 rounded hover:bg-yellow-200">🔧 Maintenance</button>`;
        } else if (canManageEquipment && eq.status === 'maintenance') {
            actions += `<button type="button" data-equipment-action="available" data-equipment-id="${escapeHtml(eq.id)}" class="text-xs bg-green-100 text-green-700 px-2 py-1 rounded hover:bg-green-200">✅ Mark Available</button>`;
        }
        if (canManageEquipment) actions += `<button type="button" data-equipment-action="edit" data-equipment-id="${escapeHtml(eq.id)}" class="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded hover:bg-blue-100">Edit</button>`;
        if (canManageEquipment && eq.status !== 'checked-out') {
            actions += `<button type="button" data-equipment-action="delete" data-equipment-id="${escapeHtml(eq.id)}" class="text-xs bg-red-50 text-red-700 px-2 py-1 rounded hover:bg-red-100">Remove</button>`;
        }

        tbody.innerHTML += `
            <tr>
                <td class="border p-2 text-center">${photoHtml}</td>
                <td class="border p-2 font-medium">${escapeHtml(eq.name)}</td>
                <td class="border p-2">${escapeHtml(eq.category)}</td>
                <td class="border p-2 text-xs text-gray-500">${escapeHtml(eq.serialNumber || '—')}</td>
                <td class="border p-2 text-center">${statusBadge}</td>
                <td class="border p-2 text-center">${dueDate}</td>
                <td class="border p-2">${escapeHtml(eq.currentLocation || '—')}${eq.status === 'missing' ? ' <span class="ml-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold status-missing">Missing</span>' : ''}</td>
                <td class="border p-2 text-center">${borrowerInfo}</td>
                <td class="border p-2 text-center">${conditionBadge}</td>
                <td class="border p-2">${escapeHtml(eq.createdBy || 'Not recorded')}</td>
                <td class="border p-2 text-center no-print ${canManageEquipment ? '' : 'hidden'}"><div class="flex flex-wrap justify-center gap-1">${actions}</div></td>
            </tr>
        `;
    });
}

function formatDateOnly(value) {
    if (!value) return '—';
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString();
}

async function handleEquipmentAction(event) {
    const button = event.target.closest('[data-equipment-action]');
    if (!button) return;
    const { equipmentAction: action, equipmentId: id } = button.dataset;
    if (action === 'edit') return openEquipmentEditor(id);
    if (action === 'delete') return removeEquipment(id);
    if (action === 'maintenance') return setMaintenance(id);
    if (action === 'available') return clearMaintenance(id);
}

function openEquipmentEditor(id) {
    const equipment = allEquipment.find(item => item.id === id);
    if (!equipment) return alert('Equipment record not found.');
    const form = document.getElementById('editEquipmentForm');
    form.elements.equipmentId.value = equipment.id;
    form.elements.name.value = equipment.name;
    form.elements.category.value = equipment.category;
    form.elements.serialNumber.value = equipment.serialNumber || '';
    form.elements.homeLocation.value = equipment.homeLocation || 'IT Room';
    const statusSelect = form.elements.status;
    statusSelect.querySelector('option[value="checked-out"]')?.remove();
    if (equipment.status === 'checked-out') {
        statusSelect.add(new Option('Deployed', 'checked-out'));
    }
    statusSelect.value = equipment.status || 'available';
    Array.from(statusSelect.options).forEach(option => {
        option.disabled = equipment.status === 'checked-out' &&
            !['checked-out', 'missing'].includes(option.value);
    });
    form.elements.condition.value = equipment.condition || 'good';
    form.elements.photo.value = '';
    updateEquipmentEditStatusFields();
    form.elements.dueDate.value = equipment.dueDate || '';
    document.getElementById('editEquipmentDialog').showModal();
}

function updateEquipmentEditStatusFields() {
    const form = document.getElementById('editEquipmentForm');
    const dueDateField = document.getElementById('editDueDateField');
    const isDeployed = form.elements.status.value === 'checked-out';
    dueDateField.classList.toggle('hidden', !isDeployed);
    form.elements.dueDate.required = isDeployed;
}

function closeEquipmentEditor() {
    document.getElementById('editEquipmentDialog').close();
}

async function saveEquipmentEdits(event) {
    event.preventDefault();
    const form = event.target;
    const id = form.elements.equipmentId.value;
    const formData = new FormData(form);
    if (!form.elements.dueDate.required) formData.delete('dueDate');
    const response = await fetch(`/api/equipment/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: formData
    });
    const result = await response.json();
    if (!response.ok || !result.success) return alert(result.message || 'Failed to update equipment.');
    closeEquipmentEditor();
    await fetchEquipmentData();
}

async function removeEquipment(id) {
    const equipment = allEquipment.find(item => item.id === id);
    if (!equipment || !confirm(`Remove ${equipment.name} from the equipment inventory? This cannot be undone.`)) return;
    const response = await fetch(`/api/equipment/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok || !result.success) return alert(result.message || 'Failed to remove equipment.');
    await fetchEquipmentData();
}

function getStatusBadge(status) {
    const map = {
        'available': '<span class="px-2 py-1 rounded-full text-xs font-semibold status-available">✅ Available</span>',
        'checked-out': '<span class="px-2 py-1 rounded-full text-xs font-semibold status-checked-out">📤 Deployed</span>',
        'maintenance': '<span class="px-2 py-1 rounded-full text-xs font-semibold status-maintenance">🔧 Maintenance</span>',
        'missing': '<span class="px-2 py-1 rounded-full text-xs font-semibold status-missing">❓ Missing</span>'
    };
    return map[status] || status;
}

function getConditionBadge(condition) {
    const map = {
        'good': '<span class="text-green-600 text-xs font-medium">Good</span>',
        'fair': '<span class="text-yellow-600 text-xs font-medium">Fair</span>',
        'needs-repair': '<span class="text-red-600 text-xs font-medium">Needs Repair</span>'
    };
    return map[condition] || condition || '—';
}

function updateEquipmentSelects(equipment) {
    const checkoutSelect = document.getElementById('eqCheckoutSelect');
    const returnSelect = document.getElementById('eqReturnSelect');

    checkoutSelect.innerHTML = '<option value="">-- Select Available Equipment --</option>';
    returnSelect.innerHTML = '<option value="">-- Select Deployed Equipment --</option>';

    equipment.forEach(eq => {
        if (eq.status === 'available') {
            checkoutSelect.innerHTML += `<option value="${escapeHtml(eq.id)}">${escapeHtml(eq.name)} (${escapeHtml(eq.category)})</option>`;
        }
        if (eq.status === 'checked-out') {
            returnSelect.innerHTML += `<option value="${escapeHtml(eq.id)}">${escapeHtml(eq.name)} — with ${escapeHtml(eq.borrower)} @ ${escapeHtml(eq.currentLocation)}${eq.dueDate ? ` (due ${formatDateOnly(eq.dueDate)})` : ''}</option>`;
        }
    });
}

function renderEquipmentLogs() {
    const query = document.getElementById('activitySearch').value.trim().toLowerCase();
    const action = document.getElementById('activityActionFilter').value;
    const sort = document.getElementById('activitySort').value;
    const logs = allEquipmentLogs.filter(log => {
        const text = `${log.equipmentName} ${log.borrower || ''} ${log.department || ''} ${log.location || ''} ${log.dueDate || ''} ${log.notes || ''} ${log.processedBy || ''}`.toLowerCase();
        return (!query || text.includes(query)) && (!action || log.action === action);
    }).sort((a, b) => sort === 'oldest'
        ? new Date(a.date) - new Date(b.date)
        : new Date(b.date) - new Date(a.date));
    updateEquipmentLogTable(getPageItems(logs, 'equipmentLogs'), logs.length);
}

function updateEquipmentLogTable(logs, totalItems) {
    const tbody = document.getElementById('equipmentLogBody');
    tbody.innerHTML = '';
    renderPaginationControls('equipmentLogPagination', 'equipmentLogs', totalItems);
    if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="border p-4 text-center text-gray-400">${allEquipmentLogs.length ? 'No activity matches your filters.' : 'No activity logged yet.'}</td></tr>`;
        return;
    }
    logs.forEach(log => {
        const actionLabels = {
            checkout: '<span class="text-orange-600 font-semibold">📤 Deployment</span>',
            return: '<span class="text-green-600 font-semibold">📥 Return</span>',
            maintenance: '<span class="text-yellow-600 font-semibold">🔧 Maintenance</span>',
            missing: '<span class="text-pink-700 font-semibold">❓ Missing</span>',
            added: '<span class="text-blue-600 font-semibold">➕ Added</span>',
            updated: '<span class="text-indigo-600 font-semibold">✏️ Updated</span>',
            removed: '<span class="text-red-600 font-semibold">🗑 Removed</span>'
        };
        const actionBadge = actionLabels[log.action] || escapeHtml(log.action);
        tbody.innerHTML += `
            <tr>
                <td class="border p-2">${new Date(log.date).toLocaleString()}</td>
                <td class="border p-2">${escapeHtml(log.equipmentName)}</td>
                <td class="border p-2 text-center">${actionBadge}</td>
                <td class="border p-2">${escapeHtml(log.borrower || '—')}</td>
                <td class="border p-2">${escapeHtml(log.department || '—')}</td>
                <td class="border p-2">${escapeHtml(log.location || '—')}</td>
                <td class="border p-2">${log.dueDate ? formatDateOnly(log.dueDate) : '—'}</td>
                <td class="border p-2 text-gray-500 text-xs">${escapeHtml(log.notes || '')}</td>
                <td class="border p-2">${escapeHtml(log.processedBy || 'Not recorded')}</td>
            </tr>
        `;
    });
}

// Add Equipment
document.getElementById('addEquipmentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const res = await fetch('/api/equipment', { method: 'POST', body: formData });
    const result = await res.json();
    if (!res.ok || !result.success) return alert(result.message || 'Failed to add equipment.');
    e.target.reset();
    e.target.querySelector('[name="homeLocation"]').value = 'IT Storage Room';
    await fetchEquipmentData();
    alert('Equipment added successfully!');
});

// Deploy Equipment
document.getElementById('checkoutEquipmentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    const eqId = data.equipmentId;
    delete data.equipmentId;

    const res = await fetch(`/api/equipment/${eqId}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    const result = await res.json();
    if (!res.ok || !result.success) return alert(result.message || 'Failed to deploy equipment.');
    e.target.reset();
    await fetchEquipmentData();
    alert('Equipment deployed!');
});

// Return Equipment
document.getElementById('returnEquipmentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    const eqId = data.equipmentId;
    delete data.equipmentId;

    const res = await fetch(`/api/equipment/${eqId}/return`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    const result = await res.json();
    if (!res.ok || !result.success) return alert(result.message || 'Failed to return equipment.');
    e.target.reset();
    await fetchEquipmentData();
    alert('Equipment returned!');
});

// Set to Maintenance
async function setMaintenance(id) {
    const notes = prompt('Maintenance notes (optional):');
    if (notes === null) return;
    const res = await fetch(`/api/equipment/${id}/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes })
    });
    const result = await res.json();
    if (result.success) fetchEquipmentData();
    else alert(result.message);
}

// Clear Maintenance (mark available)
async function clearMaintenance(id) {
    const res = await fetch(`/api/equipment/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'available' })
    });
    const result = await res.json();
    if (result.success) fetchEquipmentData();
    else alert(result.message);
}

// ============================================================
//  ANALYTICS & REPORTS
// ============================================================

let chartByItem = null;
let chartByDept = null;
let chartDaily = null;
let chartByCategory = null;

const CHART_COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
    '#06b6d4', '#d946ef', '#0ea5e9', '#e11d48', '#a3e635'
];

async function generateReport({ silent = false } = {}) {
    const startDate = document.getElementById('reportStartDate').value;
    const endDate = document.getElementById('reportEndDate').value;
    if (!startDate || !endDate || startDate > endDate) {
        if (!silent) alert('Choose a valid date range. The start date must not be after the end date.');
        return;
    }
    const params = new URLSearchParams({ startDate, endDate });

    const [consumableRes, equipmentRes] = await Promise.all([
        fetch(`/api/analytics/consumables?${params}`),
        fetch(`/api/analytics/equipment?${params}`)
    ]);
    const cData = await consumableRes.json();
    const eData = await equipmentRes.json();

    if (!consumableRes.ok || !cData.success || !equipmentRes.ok || !eData.success) {
        if (!silent) alert(cData.message || eData.message || 'Failed to generate report.');
        return;
    }
    latestReportData = { cData, eData, startDate, endDate };
    if (!silent) {
        ['reportItems', 'reportRequestors', 'reportStock', 'reportEquipment'].forEach(key => {
            paginationPages[key] = 1;
        });
    }

    document.getElementById('reportEmpty').classList.add('hidden');
    document.getElementById('reportContent').classList.remove('hidden');
    document.getElementById('exportReportButton').disabled = false;

    // Print header
    document.getElementById('printPeriod').textContent = `Period: ${formatDateOnly(startDate)} – ${formatDateOnly(endDate)}`;
    document.getElementById('printDate').textContent = new Date().toLocaleString();

    // Summary Cards
    document.getElementById('rptTotalTx').textContent = cData.totalTransactions;
    document.getElementById('rptTotalQty').textContent = cData.totalQuantity;
    document.getElementById('rptTopItem').textContent = cData.byItem.length > 0 ? `${cData.byItem[0].itemName} (${cData.byItem[0].totalQuantity})` : '—';
    document.getElementById('rptTopDept').textContent = cData.byDepartment.length > 0 ? `${cData.byDepartment[0].department} (${cData.byDepartment[0].totalQuantity})` : '—';

    // Charts
    renderBarChart('chartByItem', chartByItem, cData.byItem.map(i => i.itemName), cData.byItem.map(i => i.totalQuantity), 'Qty Consumed', (c) => { chartByItem = c; });
    renderPieChart('chartByDept', chartByDept, cData.byDepartment.map(d => d.department), cData.byDepartment.map(d => d.totalQuantity), (c) => { chartByDept = c; });
    renderLineChart('chartDaily', chartDaily, cData.dailyBreakdown.map(d => d.date), cData.dailyBreakdown.map(d => d.totalQuantity), 'Qty Consumed', (c) => { chartDaily = c; });
    renderDoughnutChart('chartByCategory', chartByCategory, cData.byCategory.map(c => c.category), cData.byCategory.map(c => c.totalQuantity), (c) => { chartByCategory = c; });

    renderCurrentReport();
}

function renderCurrentReport() {
    if (!latestReportData) return;
    const { cData, eData } = latestReportData;

    // Item breakdown table
    const itemTbody = document.getElementById('rptItemTable');
    itemTbody.innerHTML = '';
    if (cData.byItem.length === 0) {
        itemTbody.innerHTML = '<tr><td colspan="3" class="border p-3 text-center text-gray-400">No consumption this period.</td></tr>';
    } else {
        getPageItems(cData.byItem, 'reportItems').forEach(i => {
            itemTbody.innerHTML += `<tr>
                <td class="border p-2">${escapeHtml(i.itemName)}</td>
                <td class="border p-2 text-center font-semibold">${i.totalQuantity}</td>
                <td class="border p-2 text-center">${i.transactions}</td>
            </tr>`;
        });
    }
    renderPaginationControls('rptItemPagination', 'reportItems', cData.byItem.length);

    // Requestor breakdown table
    const requestorTbody = document.getElementById('rptRequestorTable');
    requestorTbody.innerHTML = '';
    if (cData.byRequestor.length === 0) {
        requestorTbody.innerHTML = '<tr><td colspan="5" class="border p-3 text-center text-gray-400">No consumption this period.</td></tr>';
    } else {
        getPageItems(cData.byRequestor, 'reportRequestors').forEach(r => {
            requestorTbody.innerHTML += `<tr>
                <td class="border p-2">${escapeHtml(r.requestor)}</td>
                <td class="border p-2">${escapeHtml(r.department)}</td>
                <td class="border p-2 text-center font-semibold">${r.totalQuantity}</td>
                <td class="border p-2 text-center">${r.transactions}</td>
                <td class="border p-2">${escapeHtml(r.processedBy || 'Not recorded')}</td>
            </tr>`;
        });
    }
    renderPaginationControls('rptRequestorPagination', 'reportRequestors', cData.byRequestor.length);

    // Stock snapshot
    const stockTbody = document.getElementById('rptStockTable');
    stockTbody.innerHTML = '';
    if (cData.stockSnapshot.length === 0) {
        stockTbody.innerHTML = '<tr><td colspan="4" class="border p-3 text-center text-gray-400">No inventory items.</td></tr>';
    }
    getPageItems(cData.stockSnapshot, 'reportStock').forEach(s => {
        const statusLabel = s.currentStock <= 0 ? '<span class="text-red-600 font-bold">OUT OF STOCK</span>'
            : s.currentStock <= (s.lowStockThreshold ?? 5) ? '<span class="text-orange-500 font-semibold">Low Stock</span>'
            : '<span class="text-green-600">In Stock</span>';
        stockTbody.innerHTML += `<tr>
            <td class="border p-2">${escapeHtml(s.name)}</td>
            <td class="border p-2 text-center">${escapeHtml(s.category)}</td>
            <td class="border p-2 text-center font-bold">${s.currentStock}</td>
            <td class="border p-2 text-center">${statusLabel}</td>
        </tr>`;
    });
    renderPaginationControls('rptStockPagination', 'reportStock', cData.stockSnapshot.length);

    // Equipment analytics
    if (eData.success) {
        const summary = eData.summary;
        document.getElementById('eqAnalyticsSummary').innerHTML = `
            <div class="bg-gray-50 p-3 rounded text-center"><p class="text-xs text-gray-500">Total Equipment</p><p class="text-xl font-bold">${summary.totalEquipment}</p></div>
            <div class="bg-green-50 p-3 rounded text-center"><p class="text-xs text-gray-500">Available</p><p class="text-xl font-bold text-green-600">${summary.available}</p></div>
            <div class="bg-red-50 p-3 rounded text-center"><p class="text-xs text-gray-500">Deployed</p><p class="text-xl font-bold text-red-600">${summary.checkedOut}</p></div>
            <div class="bg-yellow-50 p-3 rounded text-center"><p class="text-xs text-gray-500">Maintenance</p><p class="text-xl font-bold text-yellow-600">${summary.maintenance}</p></div>
            <div class="bg-pink-50 p-3 rounded text-center"><p class="text-xs text-gray-500">Missing</p><p class="text-xl font-bold text-pink-700">${summary.missing}</p></div>
        `;
        const eqTbody = document.getElementById('rptEqUsageTable');
        eqTbody.innerHTML = '';
        if (eData.mostUsed.length === 0) {
            eqTbody.innerHTML = '<tr><td colspan="2" class="border p-3 text-center text-gray-400">No equipment deployments this period.</td></tr>';
        } else {
            getPageItems(eData.mostUsed, 'reportEquipment').forEach(e => {
                eqTbody.innerHTML += `<tr>
                    <td class="border p-2">${escapeHtml(e.name)}</td>
                    <td class="border p-2 text-center font-semibold">${e.checkouts}</td>
                </tr>`;
            });
        }
        renderPaginationControls('rptEqUsagePagination', 'reportEquipment', eData.mostUsed.length);
    }
}

let latestReportData = null;

function exportReportCsv() {
    if (!latestReportData) return alert('Generate a report before exporting.');
    const { cData, eData, startDate, endDate } = latestReportData;
    const rows = [
        ['Record Type', 'Date', 'Item or Equipment', 'Requestor or Borrower', 'Department', 'Location', 'Due Date', 'Quantity', 'Processed By', 'Notes']
    ];
    cData.transactions.forEach(transaction => rows.push([
        'Consumable request',
        transaction.date,
        transaction.itemName,
        transaction.requestor,
        transaction.department,
        '',
        '',
        transaction.quantity,
        transaction.processedBy,
        ''
    ]));
    eData.deployments.forEach(deployment => rows.push([
        'Equipment deployment',
        deployment.date,
        deployment.equipmentName,
        deployment.borrower,
        deployment.department,
        deployment.location,
        deployment.dueDate,
        '',
        deployment.processedBy,
        deployment.notes
    ]));

    const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `inventory-report-${startDate}-to-${endDate}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

// --- Chart helpers ---

function renderBarChart(canvasId, existingChart, labels, data, label, setter) {
    if (existingChart) existingChart.destroy();
    const ctx = document.getElementById(canvasId).getContext('2d');
    setter(new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{ label, data, backgroundColor: CHART_COLORS.slice(0, data.length), borderRadius: 4 }]
        },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
    }));
}

function renderPieChart(canvasId, existingChart, labels, data, setter) {
    if (existingChart) existingChart.destroy();
    const ctx = document.getElementById(canvasId).getContext('2d');
    setter(new Chart(ctx, {
        type: 'pie',
        data: {
            labels,
            datasets: [{ data, backgroundColor: CHART_COLORS.slice(0, data.length) }]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    }));
}

function renderDoughnutChart(canvasId, existingChart, labels, data, setter) {
    if (existingChart) existingChart.destroy();
    const ctx = document.getElementById(canvasId).getContext('2d');
    setter(new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{ data, backgroundColor: CHART_COLORS.slice(0, data.length) }]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    }));
}

function renderLineChart(canvasId, existingChart, labels, data, label, setter) {
    if (existingChart) existingChart.destroy();
    const ctx = document.getElementById(canvasId).getContext('2d');
    setter(new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{ label, data, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3 }]
        },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
    }));
}
