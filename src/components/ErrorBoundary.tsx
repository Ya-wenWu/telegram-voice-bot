import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  sectionLabel?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

/**
 * Prevents unexpected browser media / rendering exceptions from terminating the entire SPA.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    message: '',
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || '介面發生非預期錯誤',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private handleRecover = () => {
    this.setState({ hasError: false, message: '' });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <section
          role="alert"
          className="bg-white border border-red-200 rounded-xl p-6 space-y-4 text-slate-900"
        >
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-1 min-w-0">
              <h2 className="font-display text-base font-semibold text-red-900">
                {this.props.sectionLabel ? `${this.props.sectionLabel}暫時中斷` : '畫面暫時中斷'}
              </h2>
              <p className="text-xs sm:text-sm text-slate-600">
                系統已攔截異常以防止應用程式終止，您今日的對話紀錄仍安全保存在本機。
              </p>
              {this.state.message && (
                <p className="text-xs font-mono text-red-700 bg-red-50 border border-red-100 rounded px-2.5 py-1.5 break-all">
                  {this.state.message}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={this.handleRecover}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>重新載入此分頁</span>
          </button>
        </section>
      );
    }

    return this.props.children;
  }
}
