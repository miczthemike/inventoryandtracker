const ownerSetupForm = document.getElementById('ownerSetupForm');
const loginForm = document.getElementById('loginForm');
const changePasswordForm = document.getElementById('changePasswordForm');
const message = document.getElementById('authMessage');
let forcedPasswordChange = false;

function showMessage(text) {
    message.textContent = text;
}

function showForm(form) {
    [ownerSetupForm, loginForm, changePasswordForm].forEach(entry => {
        entry.hidden = entry !== form;
    });
    showMessage('');
}

async function postJson(url, payload) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || 'The request could not be completed.');
    return result;
}

async function initializeLoginPage() {
    try {
        const response = await fetch('/api/auth/status', { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || 'Could not check sign-in status.');
        if (result.setupRequired) return showForm(ownerSetupForm);
        if (result.authenticated) {
            if (result.user.forcePasswordChange) {
                forcedPasswordChange = true;
                showPasswordChange();
            } else if (new URLSearchParams(location.search).has('change-password')) {
                showPasswordChange();
            } else {
                location.replace('/');
            }
            return;
        }
        showForm(loginForm);
    } catch (error) {
        showForm(loginForm);
        showMessage(`Unable to connect to the server: ${error.message}`);
    }
}

function showPasswordChange() {
    showForm(changePasswordForm);
    document.getElementById('passwordChangeNotice').textContent = forcedPasswordChange
        ? 'A temporary password was issued for this account. Choose a new password to continue.'
        : 'Enter your current password and choose a new one.';
    const currentGroup = document.getElementById('currentPasswordGroup');
    currentGroup.hidden = forcedPasswordChange;
    changePasswordForm.elements.currentPassword.required = !forcedPasswordChange;
}

ownerSetupForm.addEventListener('submit', async event => {
    event.preventDefault();
    try {
        await postJson('/api/auth/setup', Object.fromEntries(new FormData(ownerSetupForm).entries()));
        location.replace('/');
    } catch (error) {
        showMessage(error.message);
    }
});

loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    try {
        const result = await postJson('/api/auth/login', Object.fromEntries(new FormData(loginForm).entries()));
        if (result.user.forcePasswordChange) {
            forcedPasswordChange = true;
            showPasswordChange();
        } else {
            location.replace('/');
        }
    } catch (error) {
        showMessage(error.message);
    }
});

changePasswordForm.addEventListener('submit', async event => {
    event.preventDefault();
    try {
        await postJson('/api/auth/change-password', Object.fromEntries(new FormData(changePasswordForm).entries()));
        location.replace('/');
    } catch (error) {
        showMessage(error.message);
    }
});

initializeLoginPage();
