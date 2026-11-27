import { FormEvent, useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { API_AUTH_REQUIRED_EVENT, setApiToken } from '../services/apiAuth';

/**
 * 伺服器要求 WEB_API_TOKEN 時（遠端連線、經反向代理、或已設定 token），跳出輸入視窗。
 * 儲存後重新載入頁面，讓所有面板用新的 token 重新取資料。
 */
export function ApiTokenPrompt() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(API_AUTH_REQUIRED_EVENT, show);
    return () => window.removeEventListener(API_AUTH_REQUIRED_EVENT, show);
  }, []);

  if (!open) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setApiToken(value);
    window.location.reload();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="api-token-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-[2px]"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl border border-slate-200 space-y-4"
      >
        <div className="flex items-center gap-2.5">
          <KeyRound className="w-5 h-5 text-blue-600" aria-hidden="true" />
          <h2 id="api-token-title" className="text-base font-semibold text-slate-900">
            需要 API Token
          </h2>
        </div>
        <p className="text-sm text-slate-600">
          這個伺服器不是本機直連，需要驗證才能使用。請輸入伺服器 <code>.env</code> 裡設定的{' '}
          <code className="font-mono text-xs">WEB_API_TOKEN</code>。Token 只保存在這個分頁（關閉即清除）。
        </p>
        <input
          type="password"
          autoFocus
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="WEB_API_TOKEN"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="px-3 py-1.5 text-sm rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            稍後
          </button>
          <button
            type="submit"
            className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
          >
            儲存並重新載入
          </button>
        </div>
      </form>
    </div>
  );
}
