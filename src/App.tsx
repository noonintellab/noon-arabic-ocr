import React, { useState, useEffect, useCallback } from 'react';
import { OCRPlayground } from './components/OCRPlayground';
import { UsageInfo } from './types';

export default function App() {
  const [lang, setLang] = useState<'ar' | 'en'>('en');
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const isAr = lang === 'ar';

  const refreshUsage = useCallback(async () => {
    try {
      const r = await fetch('/api/v1/usage');
      if (r.ok) setUsage(await r.json());
    } catch {
      // the counter is informational only
    }
  }, []);

  useEffect(() => {
    refreshUsage();
  }, [refreshUsage]);

  const toggleLang = () => {
    const next = lang === 'ar' ? 'en' : 'ar';
    setLang(next);
    document.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = next;
  };

  const resetLabel = usage
    ? new Date(usage.resetAtIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <div className="min-h-screen bg-white text-neutral-900 flex flex-col antialiased selection:bg-neutral-900 selection:text-white">
      <header className="border-b border-neutral-200">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-neutral-900 text-white flex items-center justify-center font-arabic-classic text-lg leading-none">
              ن
            </div>
            <span className="text-sm font-semibold tracking-[0.14em] uppercase">Noon OCR</span>
          </div>

          <div className="flex items-center gap-6">
            {usage && (
              <div
                className="hidden sm:flex items-baseline gap-2"
                title={isAr ? `يتجدد الرصيد الساعة ${resetLabel}` : `Resets at ${resetLabel}`}
              >
                <span className="text-sm font-semibold tabular-nums">{usage.remaining.toLocaleString()}</span>
                <span className="text-[10px] uppercase tracking-[0.12em] text-neutral-500">
                  {isAr ? 'عملية متبقية اليوم' : 'extractions left today'}
                </span>
              </div>
            )}

            <button
              onClick={toggleLang}
              className="text-[11px] uppercase tracking-[0.12em] border border-neutral-300 px-3 py-1.5 hover:border-neutral-900 hover:bg-neutral-900 hover:text-white transition-colors cursor-pointer"
            >
              {lang === 'ar' ? 'English' : 'عربي'}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-12">
        <div className="max-w-2xl mb-12">
          <div className="w-8 h-0.5 bg-red-600 mb-6" />
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight text-balance">
            {isAr ? 'استخراج النص العربي من الصور والمستندات' : 'Arabic text extraction from images and documents'}
          </h1>
          <p className="mt-4 text-neutral-600 leading-relaxed">
            {isAr
              ? 'ارفع صورة أو مستند PDF واحصل على النص العربي كاملاً — بما في ذلك الخط اليدوي والمخطوطات والنصوص المشكّلة.'
              : 'Upload an image or PDF and get the full Arabic text back — including handwriting, manuscripts and vocalised script.'}
          </p>
        </div>

        <OCRPlayground lang={lang} usage={usage} onUsageChange={setUsage} onRefreshUsage={refreshUsage} />
      </main>

      <footer className="border-t border-neutral-200 mt-16">
        <div className="max-w-6xl mx-auto px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-[11px] uppercase tracking-[0.12em] text-neutral-500">
          <span>{isAr ? 'نون — محرك التعرف على النص العربي' : 'Noon — Arabic recognition engine'}</span>
          {usage && (
            <span>
              {isAr
                ? `${usage.remaining.toLocaleString()} عملية متبقية · يتجدد الرصيد ${resetLabel}`
                : `${usage.remaining.toLocaleString()} extractions left · resets ${resetLabel}`}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}
