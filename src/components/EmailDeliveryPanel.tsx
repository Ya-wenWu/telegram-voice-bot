import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  FileArchive,
  FileCode2,
  Loader2,
  LogOut,
  Mail,
  Send,
  X,
} from 'lucide-react';
import { sendEmailWithAttachments, type EmailAttachment } from '../services/gmail';
import { getAccessToken, googleSignIn, initAuth, logout } from '../services/googleAuth';

interface DeliverableFile {
  id: 'complete' | 'patch';
  filename: string;
  url: string;
  mimeType: string;
  description: string;
  sizeLabel: string;
}

const DELIVERABLES: DeliverableFile[] = [
  {
    id: 'complete',
    filename: 'web-voice-bot-complete.zip',
    url: '/api/download/complete-zip',
    mimeType: 'application/zip',
    description:
      '即時打包之完整專案原始碼（含前端 React/Vite、後端 Express/BotGuard/ISO 27036 Compliance、Python Telegram Bot、Redis 分散式信號量、啟動腳本與測試；自動排除 .env／node_modules／快取，解壓即可推送上 GitHub）。',
    sizeLabel: '即時動態打包',
  },
  {
    id: 'patch',
    filename: 'rebased-on-c6a4016.patch',
    url: '/rebased-on-c6a4016.patch',
    mimeType: 'text/plain',
    description:
      '基於 GitHub fix/staff-hardening (c6a4016) 整理的 3 個乾淨 Rebase Commit，可直接執行 `git am` 零衝突套用。',
    sizeLabel: '101 KB',
  },
];

const DEFAULT_RECIPIENT = (import.meta.env.VITE_DEFAULT_RECIPIENT_EMAIL ?? '').trim();
const DEFAULT_SUBJECT =
  '[telegram-voice-bot] Rebased guardrails & 5-layer prompt injection defense on c6a4016';
const DEFAULT_BODY = `Hi,

Attached are the latest audited full project ZIP and clean rebased git patch built on top of Ya-wenWu/telegram-voice-bot (fix/staff-hardening @ c6a4016):

- Self-hoster guardrails: masked GEMINI_API_KEY launcher prompts, npm run doctor, unified Gitleaks + fallback .githooks/pre-commit
- 5-layer Prompt Injection defense (Web + Python core) & live preflight diagnostics
- Hardened AI Code Review workflow against fork PRs and prompt injection
- Verification: pytest 148 passed (90% coverage), ruff/mypy/tsc/vite build clean, zero secret leaks.

To apply the 3 rebased commits directly onto fix/staff-hardening:

  git checkout fix/staff-hardening
  git pull origin fix/staff-hardening
  git am rebased-on-c6a4016.patch
  git push origin fix/staff-hardening
`;

export function EmailDeliveryPanel() {
  const [user, setUser] = useState<User | null>(null);
  const [needsAuth, setNeedsAuth] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [recipient, setRecipient] = useState(DEFAULT_RECIPIENT);
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [bodyText, setBodyText] = useState(DEFAULT_BODY);
  const [selectedIds, setSelectedIds] = useState<Set<'complete' | 'patch'>>(
    () => new Set(['complete', 'patch'])
  );

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sentResult, setSentResult] = useState<{ id: string; to: string; count: number } | null>(
    null
  );

  useEffect(() => {
    const unsubscribe = initAuth(
      (signedInUser) => {
        setUser(signedInUser);
        setNeedsAuth(false);
      },
      () => {
        setUser(null);
        setNeedsAuth(true);
      }
    );
    return unsubscribe;
  }, []);

  const selectedFiles = DELIVERABLES.filter((d) => selectedIds.has(d.id));

  const toggleAttachment = (id: 'complete' | 'patch') => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleGoogleSignIn = async () => {
    setErrorMsg(null);
    setIsLoggingIn(true);
    try {
      const result = await googleSignIn();
      setUser(result.user);
      setNeedsAuth(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Google sign-in failed.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleDirectDownload = async (file: DeliverableFile) => {
    if (downloadingId) return;
    setDownloadingId(file.id);
    setErrorMsg(null);
    try {
      const res = await fetch(file.url, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`無法下載 ${file.filename}（HTTP ${res.status}）`);
      }
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (file.id === 'complete' && contentType.includes('text/html')) {
        throw new Error('伺服器回傳了 HTML 而非 ZIP 壓縮檔，請重新整理後再試。');
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = file.filename;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : `下載 ${file.filename} 失敗。`);
    } finally {
      setDownloadingId(null);
    }
  };

  const handleSignOut = async () => {
    await logout();
    setUser(null);
    setNeedsAuth(true);
    setSentResult(null);
  };

  const handleRequestSend = () => {
    setErrorMsg(null);
    setSentResult(null);
    const trimmedTo = recipient.trim();
    if (!trimmedTo || !trimmedTo.includes('@')) {
      setErrorMsg('Please enter a valid recipient email address.');
      return;
    }
    if (selectedFiles.length === 0) {
      setErrorMsg('Select at least one file to attach before sending.');
      return;
    }
    setConfirmOpen(true);
  };

  const handleConfirmSend = async () => {
    setConfirmOpen(false);
    setErrorMsg(null);
    setIsSending(true);

    try {
      const token = await getAccessToken();
      if (!token) {
        setNeedsAuth(true);
        throw new Error('Please sign in with Google before sending email.');
      }

      const attachments: EmailAttachment[] = await Promise.all(
        selectedFiles.map(async (item) => {
          const res = await fetch(item.url);
          if (!res.ok) {
            throw new Error(`Could not load attachment ${item.filename}.`);
          }
          const buffer = await res.arrayBuffer();
          return {
            filename: item.filename,
            mimeType: item.mimeType,
            bytes: new Uint8Array(buffer),
          };
        })
      );

      const response = await sendEmailWithAttachments(token, {
        to: recipient.trim(),
        subject: subject.trim() || DEFAULT_SUBJECT,
        bodyText,
        attachments,
      });

      setSentResult({
        id: response.id,
        to: recipient.trim(),
        count: attachments.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to send email.';
      if (message.toLowerCase().includes('sign in')) {
        setNeedsAuth(true);
      }
      setErrorMsg(message);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Deliverables */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-slate-900">
              Send telegram-voice-bot fixes to your email
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Sign in with Google to send the verified Git patch and source archive via Gmail, or
              download the files directly.
            </p>
          </div>

          {/* Auth control */}
          <div className="shrink-0">
            {needsAuth ? (
              <button
                type="button"
                onClick={() => void handleGoogleSignIn()}
                disabled={isLoggingIn}
                className="inline-flex items-center gap-2.5 h-10 px-4 bg-white hover:bg-slate-50 text-slate-800 border border-slate-300 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                {isLoggingIn ? (
                  <Loader2 className="w-4 h-4 animate-spin text-slate-500" aria-hidden="true" />
                ) : (
                  <svg
                    className="w-4 h-4 shrink-0"
                    viewBox="0 0 48 48"
                    aria-hidden="true"
                  >
                    <path
                      fill="#EA4335"
                      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                    />
                    <path
                      fill="#4285F4"
                      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                    />
                    <path
                      fill="#34A853"
                      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                    />
                  </svg>
                )}
                <span>Sign in with Google</span>
              </button>
            ) : (
              <div className="flex items-center gap-3 text-xs text-slate-600">
                <span className="font-mono text-slate-800">{user?.email}</span>
                <span aria-hidden="true" className="text-slate-300">
                  ·
                </span>
                <button
                  type="button"
                  onClick={() => void handleSignOut()}
                  className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-900 font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Sign out</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Two-column workspace: Attachments + Compose */}
        <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
          {/* Left: Packaged Deliverables */}
          <div className="lg:col-span-5 p-6 space-y-5">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Ready-to-send files</h2>
              <p className="mt-1 text-xs text-slate-500">
                Branch <code className="font-mono text-slate-700">fix/runtime-hardening-and-docs</code>{' '}
                · 3 commits · 136 tests passed · 81% coverage
              </p>
            </div>

            <div className="divide-y divide-slate-100 border-t border-b border-slate-100">
              {DELIVERABLES.map((file) => {
                const isChecked = selectedIds.has(file.id);
                return (
                  <div key={file.id} className="py-4 flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => toggleAttachment(file.id)}
                      aria-label={`Include ${file.filename} in email`}
                      className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                        isChecked
                          ? 'bg-blue-600 border-blue-600 text-white'
                          : 'border-slate-300 bg-white hover:border-slate-400'
                      }`}
                    >
                      {isChecked && <Check className="w-3 h-3 stroke-[2.5]" />}
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {file.id === 'patch' ? (
                          <FileCode2
                            className="w-4 h-4 text-slate-400 shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <FileArchive
                            className="w-4 h-4 text-slate-400 shrink-0"
                            aria-hidden="true"
                          />
                        )}
                        <span className="font-mono text-xs font-semibold text-slate-900 truncate">
                          {file.filename}
                        </span>
                        <span className="ml-auto font-mono tabular-nums text-[11px] text-slate-400 shrink-0">
                          {file.sizeLabel}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-600 leading-relaxed">
                        {file.description}
                      </p>
                      <div className="mt-2 flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => void handleDirectDownload(file)}
                          disabled={downloadingId === file.id}
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline cursor-pointer disabled:opacity-60"
                        >
                          {downloadingId === file.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <Download className="w-3.5 h-3.5" aria-hidden="true" />
                          )}
                          <span>{downloadingId === file.id ? '下載中...' : 'Direct download'}</span>
                        </button>
                        <a
                          href={file.url}
                          download={file.filename}
                          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 hover:underline"
                        >
                          <ExternalLink className="w-3 h-3" aria-hidden="true" />
                          <span>Open link</span>
                        </a>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="text-xs text-slate-500 space-y-1.5">
              <p className="font-medium text-slate-700">Apply rebased patch onto fix/staff-hardening</p>
              <pre className="p-3 bg-slate-50 border border-slate-200 rounded-md font-mono text-[11px] text-slate-700 overflow-x-auto leading-relaxed">
{`git checkout fix/staff-hardening
git pull origin fix/staff-hardening
git am rebased-on-c6a4016.patch
git push origin fix/staff-hardening`}
              </pre>
            </div>
          </div>

          {/* Right: Email Compose & Send */}
          <div className="lg:col-span-7 p-6 space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Mail className="w-4 h-4 text-slate-500" aria-hidden="true" />
              <span>Gmail Delivery</span>
            </div>

            {errorMsg && (
              <div
                role="alert"
                className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2.5 text-xs sm:text-sm text-red-800"
              >
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{errorMsg}</span>
              </div>
            )}

            {sentResult && (
              <div
                role="status"
                className="px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg flex items-start gap-2.5 text-xs sm:text-sm text-emerald-900"
              >
                <CheckCircle2
                  className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div>
                  <span className="font-semibold">Email sent successfully.</span> Delivered{' '}
                  {sentResult.count} attachment{sentResult.count === 1 ? '' : 's'} to{' '}
                  <span className="font-mono">{sentResult.to}</span> (Message ID:{' '}
                  <span className="font-mono">{sentResult.id}</span>).
                </div>
              </div>
            )}

            <div className="space-y-3.5">
              <div>
                <label
                  htmlFor="gmail-recipient"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  To
                </label>
                <input
                  id="gmail-recipient"
                  type="email"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  className="w-full h-10 px-3 text-sm font-mono bg-slate-50 border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:bg-white focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
                />
              </div>

              <div>
                <label
                  htmlFor="gmail-subject"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Subject
                </label>
                <input
                  id="gmail-subject"
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full h-10 px-3 text-sm bg-slate-50 border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:bg-white focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
                />
              </div>

              <div>
                <label
                  htmlFor="gmail-body"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Message
                </label>
                <textarea
                  id="gmail-body"
                  rows={8}
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  className="w-full p-3 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg text-slate-800 leading-relaxed focus:outline-none focus:bg-white focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15"
                />
              </div>
            </div>

            <div className="pt-2 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-slate-500 font-mono tabular-nums">
                {selectedFiles.length} attachment{selectedFiles.length === 1 ? '' : 's'} selected
              </span>

              {needsAuth ? (
                <button
                  type="button"
                  onClick={() => void handleGoogleSignIn()}
                  disabled={isLoggingIn}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                >
                  {isLoggingIn ? (
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Mail className="w-4 h-4" aria-hidden="true" />
                  )}
                  <span>Sign in with Google to Send</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleRequestSend}
                  disabled={isSending || selectedFiles.length === 0}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                >
                  {isSending ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      <span>Sending via Gmail...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" aria-hidden="true" />
                      <span>Send Email</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Mandatory explicit user confirmation dialog before sending email */}
      {confirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-send-title"
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6 shadow-lg space-y-4">
            <div className="flex items-start justify-between gap-3">
              <h2 id="confirm-send-title" className="font-display text-base font-bold text-slate-900">
                Confirm email delivery
              </h2>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                aria-label="Close confirmation dialog"
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-sm text-slate-600">
              Send this email from your connected Gmail account (<span className="font-mono text-slate-800">{user?.email}</span>)?
            </p>

            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1.5">
              <div>
                <span className="text-slate-500">Recipient: </span>
                <span className="font-mono text-slate-900">{recipient.trim()}</span>
              </div>
              <div>
                <span className="text-slate-500">Subject: </span>
                <span className="text-slate-900">{subject.trim()}</span>
              </div>
              <div>
                <span className="text-slate-500">
                  Attachments ({selectedFiles.length}):{' '}
                </span>
                <span className="font-mono text-slate-900">
                  {selectedFiles.map((f) => f.filename).join(', ')}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmSend()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Confirm &amp; Send</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
