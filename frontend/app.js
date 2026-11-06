// Update these two production URLs after deploying backend/AI services.
const PROD_BACKEND_ORIGIN = 'https://final-year-project-1-f1cu.onrender.com';
const PROD_AI_ORIGIN = 'https://final-year-project-0joz.onrender.com';

const BACKEND_ORIGIN = PROD_BACKEND_ORIGIN;
const AI_URL = PROD_AI_ORIGIN;
const API_URL = `${BACKEND_ORIGIN}/api`;
const IMG_URL_BASE = `${BACKEND_ORIGIN}/`;
const IS_FORCED_PUBLIC_VIEW = new URLSearchParams(window.location.search).get('view') === 'public';

const PUBLIC_PATHS_FOR_GUEST = new Set([
    'index',
    'login',
    'register',
    'forgot_password',
    'reset_password',
    'user/case',
    'how-it-works'
]);

let notificationPollTimer = null;

// --- Auth Utils ---
function parseTokenPayload(token) {
    if (!token) return null;
    try {
        return JSON.parse(atob(token.split('.')[1]));
    } catch (e) {
        return null;
    }
}

function isTokenExpired(token) {
    const payload = parseTokenPayload(token);
    if (!payload || !payload.exp) return false;
    const nowInSeconds = Math.floor(Date.now() / 1000);
    return nowInSeconds >= payload.exp;
}

function getToken() {
    const token = localStorage.getItem('token');
    if (!token) return null;

    if (isTokenExpired(token)) {
        localStorage.removeItem('token');
        return null;
    }

    return token;
}

function getUserRole() {
    const token = getToken();
    if (!token) return null;
    const payload = parseTokenPayload(token);
    return payload?.user?.role || null;
}

function isLoggedIn() {
    return !!getToken();
}

function isValidGmail(email) {
    return /^[^\s@]+@gmail\.com$/i.test(String(email || '').trim());
}

function getActiveTranslations() {
    const lang = localStorage.getItem('preferredLanguage') || 'en';
    return (typeof translations !== 'undefined' && translations[lang]) || (typeof translations !== 'undefined' ? translations.en : {});
}

function isStrongPassword(password) {
    return /^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(String(password || ''));
}

function getDashboardPath(role) {
    if (role === 'admin') return '/system_admin/index.html';
    if (role === 'law_enforcement') return '/police_admin/dashboard.html';
    return '/user/dashboard.html';
}

function getPasswordRuleMessage() {
    const t = getActiveTranslations();
    return t.auth_password_rule || 'Password must be at least 8 characters and include both letters and numbers.';
}

function localizeAuthMessage(message) {
    const t = getActiveTranslations();
    const normalized = String(message || '').trim();
    const messageMap = {
        'Email must end with @gmail.com': t.auth_email_gmail_only,
        'Password is required': t.auth_password_required,
        'Password must be at least 8 characters and include both letters and numbers.': t.auth_password_rule,
        'Please fix the errors below': t.auth_fix_errors,
        'Login successful!': t.auth_login_success,
        'Registration submitted for approval!': t.auth_register_submitted,
        'Account created successfully!': t.auth_register_success
    };

    return messageMap[normalized] || normalized;
}

function togglePasswordVisibility(inputId, iconId) {
    const input = document.getElementById(inputId);
    const icon = document.getElementById(iconId);
    if (!input || !icon) return;

    const nextType = input.type === 'password' ? 'text' : 'password';
    input.type = nextType;
    icon.className = nextType === 'text' ? 'fas fa-eye-slash' : 'fas fa-eye';
}

function logout() {
    localStorage.removeItem('token');
    window.location.href = '/index.html';
}

async function apiCall(endpoint, method = 'GET', body = null, isFormData = false) {
    const headers = {};
    const token = getToken();
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    
    // If not FormData, set Content-Type JSON
    if (!isFormData) {
        headers['Content-Type'] = 'application/json';
    }

    const config = {
        method,
        headers,
    };

    if (body) {
        config.body = isFormData ? body : JSON.stringify(body);
        // Explicitly delete Content-Type for FormData to let browser set boundary
        if (isFormData) delete headers['Content-Type']; 
    }

    const res = await fetch(`${API_URL}${endpoint}`, config);
    const raw = await res.text();
    let data = {};

    if (raw) {
        try {
            data = JSON.parse(raw);
        } catch (e) {
            data = { msg: raw };
        }
    }
    
    if (!res.ok) {
        const error = new Error(data.msg || data.error || 'API Error');
        error.status = res.status;
        error.payload = data;

        if (res.status === 401) {
            localStorage.removeItem('token');
            stopNotificationPolling();

            const path = decodeURIComponent(window.location.pathname || '/').replace(/^\/+|\/+$/g, '');
            const currentPath = path || 'index';
            const canonicalPath = currentPath.endsWith('.html') ? currentPath.slice(0, -5) : currentPath;
            const publicAuthPages = new Set(['index', 'login', 'register', 'forgot_password', 'reset_password', 'user/case', 'how-it-works']);

            if (!publicAuthPages.has(canonicalPath)) {
                window.location.href = '/login.html';
            }
        }

        throw error;
    }
    return data;
}

function showToast(message, type = 'info', duration = 4200) {
    if (!message) return;

    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.setAttribute('aria-live', 'polite');
        container.setAttribute('aria-atomic', 'true');
        document.body.appendChild(container);
    }

    const existingToasts = Array.from(container.querySelectorAll('.toast'));
    if (existingToasts.length >= 4) {
        existingToasts[0].remove();
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const iconByType = {
        success: 'fa-circle-check',
        error: 'fa-circle-xmark',
        warning: 'fa-triangle-exclamation',
        info: 'fa-circle-info'
    };

    const icon = document.createElement('i');
    icon.className = `fas ${iconByType[type] || iconByType.info}`;
    icon.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'toast-body';

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = String(message);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Dismiss notification');
    closeBtn.innerHTML = '<i class="fas fa-xmark" aria-hidden="true"></i>';

    const progress = document.createElement('div');
    progress.className = 'toast-progress';
    progress.style.animationDuration = `${Math.max(1800, duration)}ms`;

    body.appendChild(text);
    body.appendChild(progress);

    toast.appendChild(icon);
    toast.appendChild(body);
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    const dismissToast = () => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 220);
    };

    closeBtn.addEventListener('click', dismissToast);
    setTimeout(dismissToast, Math.max(1800, duration));
}

window.showToast = showToast;

if (!window.__toastAlertBridgeInitialized) {
    const nativeAlert = window.alert.bind(window);
    window.alert = function patchedAlert(message) {
        if (typeof window.showToast === 'function') {
            window.showToast(String(message || ''), 'info', 5000);
            return;
        }
        nativeAlert(message);
    };
    window.__toastAlertBridgeInitialized = true;
}

// --- Enhanced Loading State Management ---

/**
 * Set a button to loading state with spinner
 * @param {HTMLElement} button - The button element
 * @param {string} text - Loading text (optional)
 */
function setButtonLoading(button, text = 'Loading...') {
    if (!button) return;
    button.disabled = true;
    const originalHTML = button.innerHTML;
    button.dataset.originalHTML = originalHTML;
    button.innerHTML = `<div class="spinner" style="width:16px;height:16px;border-width:2px;margin-right:8px;"></div>${text}`;
    button.classList.add('btn-loading');
}

/**
 * Reset button from loading state
 * @param {HTMLElement} button - The button element
 */
function resetButtonLoading(button) {
    if (!button) return;
    button.disabled = false;
    if (button.dataset.originalHTML) {
        button.innerHTML = button.dataset.originalHTML;
    }
    button.classList.remove('btn-loading');
}

/**
 * Show loading overlay
 * @param {string} message - Optional loading message
 */
function showLoadingOverlay(message = 'Loading...') {
    let overlay = document.getElementById('loading-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'loading-overlay';
        overlay.className = 'loading-overlay';
        overlay.innerHTML = `
            <div class="loading-box">
                <div class="spinner" style="width:32px;height:32px;border-width:3px;"></div>
                <div class="loading-box-text">${message}</div>
            </div>
        `;
        document.body.appendChild(overlay);
    }
    overlay.classList.add('active');
}

/**
 * Hide loading overlay
 */
function hideLoadingOverlay() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.classList.remove('active');
    }
}

/**
 * Validate form inputs
 * @param {string|HTMLElement} formSelector - Form selector or element
 * @param {Object} rules - Validation rules: { fieldName: { required: true, pattern: /regex/, minLength: 8 } }
 * @returns {boolean}
 */
function validateForm(formSelector, rules = {}) {
    const form = typeof formSelector === 'string'
        ? document.querySelector(formSelector)
        : formSelector;

    if (!form) return false;

    let isValid = true;
    const inputs = form.querySelectorAll('input, select, textarea');

    inputs.forEach(input => {
        const fieldName = input.name || input.id;
        const rule = rules[fieldName];
        let error = null;

        // Check required
        if (rule?.required && !input.value.trim()) {
            error = `${fieldName} is required`;
            isValid = false;
        }

        // Check pattern
        if (!error && rule?.pattern && !rule.pattern.test(input.value)) {
            error = `${fieldName} format is invalid`;
            isValid = false;
        }

        // Check minLength
        if (!error && rule?.minLength && input.value.length < rule.minLength) {
            error = `${fieldName} must be at least ${rule.minLength} characters`;
            isValid = false;
        }

        // Check maxLength
        if (!error && rule?.maxLength && input.value.length > rule.maxLength) {
            error = `${fieldName} must not exceed ${rule.maxLength} characters`;
            isValid = false;
        }

        // Update UI
        const group = input.closest('.form-group');
        if (group) {
            group.classList.remove('has-error', 'has-success');
            let errorEl = group.querySelector('.error-text');
            if (error) {
                group.classList.add('has-error');
                if (!errorEl) {
                    errorEl = document.createElement('div');
                    errorEl.className = 'error-text';
                    group.appendChild(errorEl);
                }
                errorEl.textContent = error;
            } else {
                if (errorEl) errorEl.remove();
            }
        }
    });

    return isValid;
}

/**
 * Clear form errors
 * @param {string|HTMLElement} formSelector - Form selector or element
 */
function clearFormErrors(formSelector) {
    const form = typeof formSelector === 'string'
        ? document.querySelector(formSelector)
        : formSelector;

    if (!form) return;

    const groups = form.querySelectorAll('.form-group.has-error, .form-group.has-success');
    groups.forEach(group => {
        group.classList.remove('has-error', 'has-success');
        const errorEl = group.querySelector('.error-text');
        const successEl = group.querySelector('.success-text');
        if (errorEl) errorEl.remove();
        if (successEl) successEl.remove();
    });
}

/**
 * Display form errors from API response
 * @param {Object|string} errors - Error object or message
 * @param {string|HTMLElement} formSelector - Form selector or element
 */
function displayFormErrors(errors, formSelector) {
    const form = typeof formSelector === 'string'
        ? document.querySelector(formSelector)
        : formSelector;

    if (!form) return;

    if (typeof errors === 'string') {
        showToast(errors, 'error');
        return;
    }

    Object.keys(errors).forEach(fieldName => {
        const input = form.querySelector(`[name="${fieldName}"], #${fieldName}`);
        if (input) {
            const group = input.closest('.form-group');
            if (group) {
                group.classList.add('has-error');
                let errorEl = group.querySelector('.error-text');
                if (!errorEl) {
                    errorEl = document.createElement('div');
                    errorEl.className = 'error-text';
                    group.appendChild(errorEl);
                }
                errorEl.textContent = errors[fieldName];
            }
        }
    });
}

/**
 * Mark form field as successful
 * @param {HTMLElement} input - Input element
 * @param {string} message - Success message
 */
function markFieldSuccess(input, message = 'Valid') {
    const group = input.closest('.form-group');
    if (!group) return;
    group.classList.remove('has-error');
    group.classList.add('has-success');
    let successEl = group.querySelector('.success-text');
    if (!successEl) {
        successEl = document.createElement('div');
        successEl.className = 'success-text';
        group.appendChild(successEl);
    }
    successEl.textContent = message;
}

/**
 * Disable all inputs in form
 * @param {HTMLElement} form - Form element
 * @param {boolean} disabled - Whether to disable
 */
function setFormDisabled(form, disabled = true) {
    if (!form) return;
    const inputs = form.querySelectorAll('input, button, select, textarea');
    inputs.forEach(el => {
        el.disabled = disabled;
    });
}

// --- UI Utils ---
function updateNav() {
    const navRight = document.getElementById('nav-right');
    if (!navRight) return;

    const role = getUserRole();
    const dashboardLink = getDashboardPath(role);

    if (isLoggedIn() && IS_FORCED_PUBLIC_VIEW) {
        stopNotificationPolling();
        navRight.innerHTML = `
            <span class="public-preview-pill" data-key="nav_public_preview">Public Preview</span>
            <a href="${dashboardLink}" data-key="nav_return_dashboard">Return to Dashboard</a>
            <a href="#" onclick="logout()" data-key="logout">Logout</a>
        `;
    } else if (isLoggedIn()) {
        const reportLink = '/user/report.html';
        const myReportsLink = role === 'law_enforcement' ? '/police_admin/my-reports.html' : '/user/my-reports.html';
        const reportHtml = role === 'admin'
            ? ''
            : `<a href="${reportLink}" data-key="nav_report">Report/Upload</a>`;
        const myReportsHtml = role === 'admin'
            ? ''
            : `<a href="${myReportsLink}">My Reports</a>`;
        
        navRight.innerHTML = `
            <a href="${dashboardLink}" title="Dashboard" data-key="dashboard">Dashboard</a>
            <a href="#" id="notif-btn" onclick="toggleNotif()" style="position:relative;">
                🔔 <span id="notif-count" style="display:none; background:red; color:white; border-radius:50%; padding:2px 5px; font-size:0.6rem; position:absolute; top:-5px; right:-5px;">0</span>
            </a>
            ${reportHtml}
            ${myReportsHtml}
            <a href="#" onclick="logout()" data-key="logout">Logout</a>
            <!-- Notification Dropdown -->
            <div id="notif-dropdown" style="display:none; position:absolute; right:120px; top:50px; background:white; color:black; border:1px solid #ddd; width:300px; max-height:300px; overflow-y:auto; z-index:1000; box-shadow:0 2px 10px rgba(0,0,0,0.1);">
                <div style="padding:10px; border-bottom:1px solid #eee; font-weight:bold;">Notifications</div>
                <div id="notif-list"></div>
            </div>
        `;
        startNotificationPolling();
    } else {
        stopNotificationPolling();
        navRight.innerHTML = `
            <a href="/login.html" data-key="login_title">Login</a>
            <a href="/register.html" data-key="register">Register</a>
        `;
    }
    
    // Re-apply translation if function exists
    if(typeof changeLanguage === 'function' && localStorage.getItem('preferredLanguage')) {
        changeLanguage(localStorage.getItem('preferredLanguage'));
    }
}

async function checkNotifications() {
     if (!isLoggedIn()) {
         stopNotificationPolling();
         return;
     }

     try {
         const updates = await apiCall('/people/notifications?unreadOnly=1');
         const badge = document.getElementById('notif-count');
         const list = document.getElementById('notif-list');
         if(!badge || !list) return;

         const unreadOnly = updates.filter(n => !n.isRead);
         const unread = unreadOnly.length;
         if(unread > 0) {
             badge.innerText = unread;
             badge.style.display = 'inline-block';
         } else {
             badge.style.display = 'none';
         }

         if(!unreadOnly.length) {
            list.innerHTML = '<div style="padding:10px; color:#6b7280; font-size:0.85rem;">No notifications yet.</div>';
            return;
         }

         list.innerHTML = unreadOnly.map(u => {
            const redirectTo = u.relatedPersonId ? `/user/case.html?id=${encodeURIComponent(u.relatedPersonId)}` : '/user/dashboard.html';
            return `
                <a href="${redirectTo}" onclick="markNotificationRead('${u._id}')" style="display:block; text-decoration:none; color:inherit; padding:10px; border-bottom:1px solid #eee; font-size:0.9rem; background:rgba(59,130,246,0.08);">
                    ${u.message}<br><span style="font-size:0.72rem; color:grey;">${new Date(u.createdAt).toLocaleString()}</span>
                </a>
            `;
         }).join('');
     } catch(e) {
         if (e && e.status === 401) {
             stopNotificationPolling();
             return;
         }
     }
}

function startNotificationPolling() {
    if (notificationPollTimer) return;
    checkNotifications();
    notificationPollTimer = setInterval(checkNotifications, 12000);
}

function stopNotificationPolling() {
    if (!notificationPollTimer) return;
    clearInterval(notificationPollTimer);
    notificationPollTimer = null;
}

async function markNotificationRead(notificationId) {
    if (!notificationId) return;
    try {
        await apiCall(`/people/notifications/${notificationId}/read`, 'PUT', {});
        checkNotifications();
    } catch (e) {
        console.log('Failed to mark notification as read');
    }
}

function toggleNotif() {
    const d = document.getElementById('notif-dropdown');
    if(d.style.display === 'none') d.style.display = 'block';
    else d.style.display = 'none';
}

// Check auth on protected pages
function checkAuth() {
    if (IS_FORCED_PUBLIC_VIEW) {
        return;
    }

    if (!isLoggedIn()) {
        window.location.href = '/login.html';
    }
}

function enforceGuestAccess() {
    if (isLoggedIn()) return;

    const path = decodeURIComponent(window.location.pathname || '/').replace(/^\/+|\/+$/g, '');
    const currentPath = path || 'index';
    const canonicalPath = currentPath.endsWith('.html')
        ? currentPath.slice(0, -5)
        : currentPath;

    if (!PUBLIC_PATHS_FOR_GUEST.has(canonicalPath)) {
        window.location.href = '/login.html';
    }
}

enforceGuestAccess();
