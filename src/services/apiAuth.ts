// 後端非公開路由（/api/*、/metrics、原始碼 ZIP）要求 WEB_API_TOKEN。
// 這裡在程式進入點包裝 window.fetch：只對「同源」且「受保護」的路徑自動帶上
// `Authorization: Bearer <token>`，並在伺服器回 401（或要求 WEB_API_TOKEN 的 403）時通知 UI 要使用者輸入。
// 其他網域（GitHub、Google 等）完全不處理，token 不會送出去。

const TOKEN_KEY = 'webApiToken';
export const API_AUTH_REQUIRED_EVENT = 'web-api-auth-required';

const PROTECTED_PATHS = [/^\/api\//, /^\/metrics$/, /^\/web-voice-bot-complete\.zip$/];

// sessionStorage：關閉分頁就清除，比 localStorage 保留更短，被讀走的時間窗也更小。
export function getApiToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setApiToken(token: string): void {
  try {
    const value = token.trim();
    if (value) window.sessionStorage.setItem(TOKEN_KEY, value);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // sessionStorage 不可用（隱私模式等）時略過：只影響需要 token 的遠端連線
  }
}

function protectedSameOriginPath(input: RequestInfo | URL): string | null {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return PROTECTED_PATHS.some((re) => re.test(url.pathname)) ? url.pathname : null;
  } catch {
    return null;
  }
}

async function signalsMissingToken(res: Response): Promise<boolean> {
  if (res.status === 401) return true;
  if (res.status !== 403) return false;
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    return typeof body.error === 'string' && body.error.includes('WEB_API_TOKEN');
  } catch {
    return false;
  }
}

export function installApiAuthFetch(): void {
  const w = window as Window & { __apiAuthFetchInstalled?: boolean };
  if (w.__apiAuthFetchInstalled) return;
  w.__apiAuthFetchInstalled = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!protectedSameOriginPath(input)) return originalFetch(input, init);

    const token = getApiToken();
    let nextInput = input;
    let nextInit = init;
    if (token) {
      const base = init?.headers ?? (input instanceof Request ? input.headers : undefined);
      const headers = new Headers(base);
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
      if (input instanceof Request) nextInput = new Request(input, { headers });
      else nextInit = { ...init, headers };
    }

    const res = await originalFetch(nextInput, nextInit);
    if (await signalsMissingToken(res)) {
      window.dispatchEvent(new CustomEvent(API_AUTH_REQUIRED_EVENT));
    }
    return res;
  };
}
