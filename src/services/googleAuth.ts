import { initializeApp, type FirebaseOptions } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  type Auth,
  type User,
} from 'firebase/auth';

export const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

// Load optional local AI Studio config without failing builds when omitted from GitHub/ZIP
const localConfigModules = import.meta.glob<{ default: FirebaseOptions }>(
  '../../firebase-applet-config.json',
  { eager: true }
);

function resolveFirebaseConfig(): FirebaseOptions | null {
  const envApiKey = import.meta.env.VITE_FIREBASE_API_KEY?.trim();
  const envAuthDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim();
  const envProjectId = import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim();

  if (envApiKey && envAuthDomain && envProjectId) {
    return {
      apiKey: envApiKey,
      authDomain: envAuthDomain,
      projectId: envProjectId,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET?.trim() || undefined,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim() || undefined,
      appId: import.meta.env.VITE_FIREBASE_APP_ID?.trim() || undefined,
    };
  }

  const localModule = Object.values(localConfigModules)[0];
  if (localModule?.default?.apiKey) {
    return localModule.default;
  }

  return null;
}

const resolvedConfig = resolveFirebaseConfig();
const auth: Auth | null = resolvedConfig ? getAuth(initializeApp(resolvedConfig)) : null;

const provider = new GoogleAuthProvider();
for (const scope of SCOPES) {
  provider.addScope(scope);
}

let isSigningIn = false;
// Keep the OAuth access token strictly in memory (never localStorage/sessionStorage).
let cachedAccessToken: string | null = null;

export function initAuth(
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
): () => void {
  if (!auth) {
    onAuthFailure?.();
    return () => {};
  }
  return onAuthStateChanged(auth, (user: User | null) => {
    if (user && cachedAccessToken) {
      onAuthSuccess?.(user, cachedAccessToken);
      return;
    }
    if (!isSigningIn) {
      cachedAccessToken = null;
      onAuthFailure?.();
    }
  });
}

export async function googleSignIn(): Promise<{ user: User; accessToken: string }> {
  if (!auth) {
    throw new Error(
      '尚未設定 Firebase Web 設定（VITE_FIREBASE_*）。如只需使用 Web Voice Bot，不需設定即可正常操作。'
    );
  }
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to obtain Gmail access token from Google sign-in.');
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } finally {
    isSigningIn = false;
  }
}

export async function getAccessToken(): Promise<string | null> {
  return cachedAccessToken;
}

export async function logout(): Promise<void> {
  if (auth) {
    await auth.signOut();
  }
  cachedAccessToken = null;
}
