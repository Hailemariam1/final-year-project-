(function () {
    const FIREBASE_WEB_CONFIG = window.FIREBASE_WEB_CONFIG || {
        apiKey: 'AIzaSyA3MUPkVDGNbe7BIvfqF5FYMQ63B3yyfII',
        authDomain: 'finalyearprojectdata-80bc9.firebaseapp.com',
        databaseURL: 'https://finalyearprojectdata-80bc9-default-rtdb.firebaseio.com',
        projectId: 'finalyearprojectdata-80bc9',
        storageBucket: 'finalyearprojectdata-80bc9.firebasestorage.app',
        messagingSenderId: '214225565077',
        appId: '1:214225565077:web:8951eb941632ea1dc8b29c',
        measurementId: 'G-BF3F5GNZDE'
    };

    let firebaseInitialized = false;

    function hasConfigValue(value) {
        return !!value && !String(value).includes('REPLACE_WITH_');
    }

    function isFirebaseConfigured() {
        return [
            FIREBASE_WEB_CONFIG.apiKey,
            FIREBASE_WEB_CONFIG.authDomain,
            FIREBASE_WEB_CONFIG.projectId,
            FIREBASE_WEB_CONFIG.appId
        ].every(hasConfigValue);
    }

    function ensureFirebaseInitialized() {
        if (!window.firebase || !window.firebase.initializeApp) {
            throw new Error('Firebase client SDK is not loaded.');
        }

        if (!isFirebaseConfigured()) {
            throw new Error('Firebase Google sign-in is not configured yet. Add your Firebase web app config to frontend/public-google-auth.js.');
        }

        if (!firebaseInitialized) {
            if (!window.firebase.apps || !window.firebase.apps.length) {
                window.firebase.initializeApp(FIREBASE_WEB_CONFIG);
            }
            firebaseInitialized = true;
        }

        return window.firebase;
    }

    async function signInPublicUserWithGoogle() {
        const firebaseApp = ensureFirebaseInitialized();
        const auth = firebaseApp.auth();
        const provider = new firebaseApp.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        if (firebaseApp.auth && firebaseApp.auth.Auth && firebaseApp.auth.Auth.Persistence) {
            await auth.setPersistence(firebaseApp.auth.Auth.Persistence.LOCAL);
        }
        const result = await auth.signInWithPopup(provider);
        const user = result && result.user;
        if (!user) {
            throw new Error('Google sign-in failed.');
        }

        return exchangeGoogleUserForBackendToken(user);
    }

    async function exchangeGoogleUserForBackendToken(user) {
        if (!user) return null;

        const idToken = await user.getIdToken(true);
        if (!idToken) {
            throw new Error('Google sign-in did not return an ID token. Please try again.');
        }
        const response = await fetch(`${API_URL}/auth/google-public`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken })
        });

        const raw = await response.text();
        let data = {};
        if (raw) {
            try {
                data = JSON.parse(raw);
            } catch (err) {
                data = { msg: raw };
            }
        }

        if (!response.ok) {
            throw new Error(data.msg || data.error || 'Google sign-in failed');
        }

        if (data.token) {
            localStorage.setItem('token', data.token);
        }

        return data;
    }

    async function completeGoogleRedirectSignIn() {
        return null;
    }

    function bindGoogleButton(buttonId, options = {}) {
        const button = document.getElementById(buttonId);
        if (!button) return;

        button.addEventListener('click', async () => {
            const loadingText = options.loadingText || 'Signing in with Google...';
            const successText = options.successText || 'Google sign-in successful!';
            const btn = button;
            const originalHtml = btn.innerHTML;

            try {
                if (typeof window.setButtonLoading === 'function') {
                    window.setButtonLoading(btn, loadingText);
                } else {
                    btn.disabled = true;
                    btn.textContent = loadingText;
                }

                const data = await signInPublicUserWithGoogle();
                if (typeof window.showToast === 'function') {
                    window.showToast(successText, 'success');
                }

                window.setTimeout(() => {
                    window.location.href = data.redirectPath || '/user/dashboard.html';
                }, 700);
            } catch (err) {
                if (typeof window.showToast === 'function') {
                    window.showToast(err.message || 'Google sign-in failed', 'error');
                } else {
                    window.alert(err.message || 'Google sign-in failed');
                }
                btn.disabled = false;
                btn.innerHTML = originalHtml;
            }
        });
    }

    function injectStyles() {
        if (document.getElementById('public-google-auth-styles')) return;

        const style = document.createElement('style');
        style.id = 'public-google-auth-styles';
        style.textContent = `
            .google-auth-section {
                margin: 1rem 0 1.25rem;
            }
            .google-auth-btn {
                width: 100%;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 10px;
                border: 1px solid rgba(148, 163, 184, 0.45);
                border-radius: 14px;
                padding: 0.95rem 1rem;
                background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
                color: #111827;
                font-weight: 700;
                font-size: 0.95rem;
                cursor: pointer;
                box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06);
                transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
            }
            .google-auth-btn:hover {
                transform: translateY(-1px);
                border-color: rgba(66, 133, 244, 0.4);
                box-shadow: 0 14px 28px rgba(15, 23, 42, 0.1);
            }
            .google-auth-btn i {
                color: #4285f4;
                font-size: 1.05rem;
            }
            .google-auth-note {
                margin-top: 0.55rem;
                font-size: 0.8rem;
                color: var(--text-secondary);
                text-align: center;
            }
            .google-auth-divider {
                display: flex;
                align-items: center;
                gap: 10px;
                margin: 1rem 0 0.85rem;
                color: var(--text-muted);
                font-size: 0.8rem;
                text-transform: uppercase;
                letter-spacing: 0.08em;
            }
            .google-auth-divider::before,
            .google-auth-divider::after {
                content: '';
                height: 1px;
                flex: 1;
                background: rgba(148, 163, 184, 0.3);
            }
        `;
        document.head.appendChild(style);
    }

    injectStyles();

    window.addEventListener('load', async () => {
        try {
            const result = await completeGoogleRedirectSignIn();
            if (result && typeof window.showToast === 'function') {
                window.showToast('Google sign-in successful!', 'success');
                window.setTimeout(() => {
                    window.location.href = result.redirectPath || '/user/dashboard.html';
                }, 700);
            }
        } catch (err) {
            if (typeof window.showToast === 'function') {
                window.showToast(err.message || 'Google sign-in failed', 'error');
            } else {
                window.alert(err.message || 'Google sign-in failed');
            }
        }
    });

    window.FIREBASE_WEB_CONFIG = FIREBASE_WEB_CONFIG;
    window.signInPublicUserWithGoogle = signInPublicUserWithGoogle;
    window.completeGoogleRedirectSignIn = completeGoogleRedirectSignIn;
    window.bindGoogleButton = bindGoogleButton;
})();