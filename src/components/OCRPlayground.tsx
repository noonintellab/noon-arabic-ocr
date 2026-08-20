import React, { useState, useRef, useEffect } from 'react';
import {
  Upload,
  Copy,
  Check,
  Download,
  ZoomIn,
  ZoomOut,
  RotateCw,
  RefreshCw,
  AlertCircle,
  Edit3,
  Save,
  X
} from 'lucide-react';
import { OCRResult, ScriptType, UsageInfo } from '../types';
import { DEMO_DOCUMENTS } from '../data/demoDocuments';

interface OCRPlaygroundProps {
  lang: 'ar' | 'en';
  usage: UsageInfo | null;
  onUsageChange: (usage: UsageInfo | null) => void;
  onRefreshUsage: () => void;
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const OCRPlayground: React.FC<OCRPlaygroundProps> = ({ lang, usage, onUsageChange, onRefreshUsage }) => {
  const isAr = lang === 'ar';

  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileBase64, setFileBase64] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string>('image/jpeg');
  const [isDragging, setIsDragging] = useState(false);

  const [scriptFocus, setScriptFocus] = useState<ScriptType | 'auto'>('auto');

  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<OCRResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [zoomLevel, setZoomLevel] = useState(1);
  const [rotation, setRotation] = useState(0);

  const [isEditing, setIsEditing] = useState(false);
  const [editedText, setEditedText] = useState('');
  const [copied, setCopied] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setEditedText(result?.fullTextArabic || '');
  }, [result]);

  const resetDocument = () => {
    setFileUrl(null);
    setFileName(null);
    setFileBase64(null);
    setResult(null);
    setEditedText('');
    setError(null);
    setZoomLevel(1);
    setRotation(0);
  };

  const readAsDataURL = (file: File | Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });

  // Downscale before upload: a full-resolution photo carries far more detail than
  // the model needs, and shrinking it cuts both upload and processing time.
  const compressImage = (file: File | Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const MAX_DIM = 2000;
        const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas not supported'));
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Could not decode image'));
      };
      img.src = objectUrl;
    });

  const startExtraction = async (source: File | Blob, name: string) => {
    if (source.size > MAX_UPLOAD_BYTES) {
      setError(isAr ? 'حجم الملف يتجاوز ٢٠ ميجابايت' : 'File exceeds the 20MB limit');
      return;
    }

    setError(null);
    setResult(null);
    setFileName(name);
    setZoomLevel(1);
    setRotation(0);

    const isPdf = source.type === 'application/pdf';
    let dataUrl: string;
    let mime = source.type || 'image/jpeg';

    try {
      if (isPdf) {
        dataUrl = await readAsDataURL(source);
      } else {
        try {
          dataUrl = await compressImage(source);
          mime = 'image/jpeg';
        } catch {
          dataUrl = await readAsDataURL(source);
        }
      }
    } catch {
      setError(isAr ? 'تعذر قراءة الملف' : 'Could not read the file');
      return;
    }

    setMimeType(mime);
    setFileBase64(dataUrl);
    setFileUrl(dataUrl);
    runOCR(dataUrl, mime);
  };

  const loadDemo = async (fileUrlPath: string, title: string) => {
    try {
      setError(null);
      const res = await fetch(fileUrlPath);
      if (!res.ok) throw new Error('not found');
      const blob = await res.blob();
      startExtraction(blob, title);
    } catch {
      setError(isAr ? 'تعذر تحميل المستند التجريبي' : 'Could not load the sample document');
    }
  };

  const runOCR = async (base64Override?: string, mimeOverride?: string) => {
    const payload = base64Override || fileBase64;
    const mime = mimeOverride || mimeType;

    if (!payload) {
      setError(isAr ? 'يرجى رفع صورة أولاً' : 'Upload an image first');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/v1/ocr/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileData: payload, mimeType: mime, scriptFocus })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.message || (isAr ? 'فشلت معالجة المستند' : 'Extraction failed'));
      }

      setResult(data as OCRResult);
      setEditedText(data.fullTextArabic || '');

      if (typeof data.remaining === 'number' && usage) {
        onUsageChange({ ...usage, remaining: data.remaining });
      }
    } catch (err: any) {
      let msg = err?.message || (isAr ? 'تعذر الاتصال بالخادم' : 'Could not reach the server');
      if (/503|high demand|UNAVAILABLE/i.test(msg)) {
        msg = isAr
          ? 'الخدمة مزدحمة مؤقتاً. يرجى إعادة المحاولة.'
          : 'The service is briefly busy. Please try again.';
      }
      setError(msg);
    } finally {
      setIsLoading(false);
      onRefreshUsage();
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(editedText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = (format: 'txt' | 'doc') => {
    if (!result) return;
    const text = editedText || result.fullTextArabic;
    let content = text;
    let mime = 'text/plain';

    if (format === 'doc') {
      content = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
        <head><meta charset='utf-8'></head>
        <body dir='rtl' style="font-family: 'Traditional Arabic', Arial, sans-serif; font-size: 14pt;">
          <p>${text.replace(/\n/g, '<br/>')}</p>
        </body></html>`;
      mime = 'application/msword';
    }

    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `noon-ocr.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const scriptLabels: Record<string, { en: string; ar: string }> = {
    auto: { en: 'Detect automatically', ar: 'كشف تلقائي' },
    islamic_script: { en: 'Islamic script', ar: 'الخط الإسلامي' },
    naskh: { en: 'Naskh', ar: 'النسخ' },
    diwani: { en: 'Diwani', ar: 'الديواني' },
    modern_handwriting: { en: 'Handwriting', ar: 'خط يدوي حديث' },
    printed_standard: { en: 'Printed', ar: 'مطبوع' }
  };

  const label = (key: string) => (isAr ? scriptLabels[key]?.ar : scriptLabels[key]?.en) || key;
  const microLabel = 'text-[10px] uppercase tracking-[0.12em] text-neutral-500';

  return (
    <div className="space-y-8">
      {/* Controls */}
      <div className="flex flex-wrap items-end justify-between gap-6 border-t border-neutral-200 pt-6">
        <div className="flex flex-col gap-2">
          <label className={microLabel} htmlFor="script-select">
            {isAr ? 'نوع الخط' : 'Script type'}
          </label>
          <select
            id="script-select"
            value={scriptFocus}
            onChange={(e) => setScriptFocus(e.target.value as ScriptType | 'auto')}
            className="border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none cursor-pointer min-w-[220px]"
          >
            {Object.keys(scriptLabels).map((key) => (
              <option key={key} value={key}>
                {label(key)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="file"
            ref={fileInputRef}
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) startExtraction(file, file.name);
              e.target.value = '';
            }}
          />
          {fileUrl && (
            <>
              <button
                onClick={() => runOCR()}
                disabled={isLoading}
                className="flex items-center gap-2 border border-neutral-300 px-4 py-2 text-sm hover:border-neutral-900 disabled:opacity-40 transition-colors cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                {isAr ? 'إعادة الاستخراج' : 'Run again'}
              </button>
              <button
                onClick={resetDocument}
                className="p-2 border border-neutral-300 hover:border-neutral-900 transition-colors cursor-pointer"
                title={isAr ? 'مسح' : 'Clear'}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 bg-neutral-900 text-white px-5 py-2 text-sm hover:bg-red-600 transition-colors cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            {isAr ? 'رفع مستند' : 'Upload document'}
          </button>
        </div>
      </div>

      {error && (
        <div className="border border-red-600 bg-red-50 px-4 py-3 flex items-start justify-between gap-4 text-sm">
          <div className="flex items-start gap-3 text-red-800">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="text-red-700 hover:text-red-900 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-neutral-200 border border-neutral-200">
        {/* Document */}
        <section className="bg-white flex flex-col min-h-[560px]">
          <header className="flex items-center justify-between px-4 h-12 border-b border-neutral-200">
            <span className={microLabel}>{isAr ? 'المستند' : 'Document'}</span>
            {fileUrl && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setZoomLevel((z) => Math.max(0.6, z - 0.2))}
                  className="p-1.5 hover:bg-neutral-100 transition-colors cursor-pointer"
                  title={isAr ? 'تصغير' : 'Zoom out'}
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <span className="text-[11px] tabular-nums text-neutral-500 w-10 text-center">
                  {Math.round(zoomLevel * 100)}%
                </span>
                <button
                  onClick={() => setZoomLevel((z) => Math.min(2.5, z + 0.2))}
                  className="p-1.5 hover:bg-neutral-100 transition-colors cursor-pointer"
                  title={isAr ? 'تكبير' : 'Zoom in'}
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setRotation((r) => (r + 90) % 360)}
                  className="p-1.5 hover:bg-neutral-100 transition-colors cursor-pointer"
                  title={isAr ? 'تدوير' : 'Rotate'}
                >
                  <RotateCw className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </header>

          <div
            className={`flex-1 relative overflow-auto flex items-center justify-center p-6 ${
              isDragging ? 'bg-neutral-100' : 'bg-neutral-50'
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) startExtraction(file, file.name);
            }}
          >
            {isLoading && (
              <div className="absolute inset-0 bg-white/90 z-10 flex flex-col items-center justify-center gap-4">
                <div className="w-6 h-6 border-2 border-neutral-300 border-t-red-600 rounded-full animate-spin" />
                <span className={microLabel}>{isAr ? 'جاري القراءة' : 'Reading document'}</span>
              </div>
            )}

            {fileUrl ? (
              <img
                src={fileUrl}
                alt={fileName || 'Document'}
                className="max-h-[440px] w-auto object-contain transition-transform duration-200"
                style={{ transform: `scale(${zoomLevel}) rotate(${rotation}deg)` }}
              />
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full h-full min-h-[400px] border border-dashed border-neutral-300 hover:border-neutral-900 transition-colors flex flex-col items-center justify-center gap-3 cursor-pointer"
              >
                <Upload className="w-5 h-5 text-neutral-400" />
                <span className="text-sm text-neutral-700">
                  {isAr ? 'اسحب صورة هنا أو اضغط للاختيار' : 'Drop an image here, or click to choose'}
                </span>
                <span className={microLabel}>JPG · PNG · WEBP · PDF · 20MB</span>
              </button>
            )}
          </div>

          {fileName && (
            <footer className="px-4 h-10 border-t border-neutral-200 flex items-center">
              <span className="text-[11px] text-neutral-500 truncate">{fileName}</span>
            </footer>
          )}
        </section>

        {/* Transcription */}
        <section className="bg-white flex flex-col min-h-[560px]">
          <header className="flex items-center justify-between px-4 h-12 border-b border-neutral-200">
            <span className={microLabel}>{isAr ? 'النص المستخرج' : 'Extracted text'}</span>
            {result && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setIsEditing(!isEditing)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] transition-colors cursor-pointer ${
                    isEditing ? 'bg-neutral-900 text-white' : 'hover:bg-neutral-100'
                  }`}
                >
                  {isEditing ? <Save className="w-3.5 h-3.5" /> : <Edit3 className="w-3.5 h-3.5" />}
                  {isEditing ? (isAr ? 'حفظ' : 'Save') : isAr ? 'تعديل' : 'Edit'}
                </button>
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] hover:bg-neutral-100 transition-colors cursor-pointer"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-red-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? (isAr ? 'تم النسخ' : 'Copied') : isAr ? 'نسخ' : 'Copy'}
                </button>
              </div>
            )}
          </header>

          {result ? (
            <>
              <div className="flex-1 overflow-y-auto p-6">
                {isEditing ? (
                  <textarea
                    value={editedText}
                    onChange={(e) => setEditedText(e.target.value)}
                    dir="rtl"
                    className="w-full h-[380px] border border-neutral-900 p-4 font-arabic-classic text-xl leading-loose focus:outline-none resize-none"
                  />
                ) : (
                  <div
                    dir="rtl"
                    className="font-arabic-classic text-xl sm:text-2xl leading-loose whitespace-pre-wrap"
                  >
                    {editedText}
                  </div>
                )}
              </div>

              <footer className="border-t border-neutral-200">
                <dl className="grid grid-cols-3 divide-x divide-neutral-200 border-b border-neutral-200 rtl:divide-x-reverse">
                  <div className="px-4 py-3">
                    <dt className={microLabel}>{isAr ? 'الثقة' : 'Confidence'}</dt>
                    <dd className="text-sm font-semibold tabular-nums mt-1">{result.overallConfidence}%</dd>
                  </div>
                  <div className="px-4 py-3">
                    <dt className={microLabel}>{isAr ? 'الكلمات' : 'Words'}</dt>
                    <dd className="text-sm font-semibold tabular-nums mt-1">
                      {editedText.split(/\s+/).filter(Boolean).length}
                    </dd>
                  </div>
                  <div className="px-4 py-3">
                    <dt className={microLabel}>{isAr ? 'الزمن' : 'Time'}</dt>
                    <dd className="text-sm font-semibold tabular-nums mt-1">
                      {(result.processingTimeMs / 1000).toFixed(1)}s
                    </dd>
                  </div>
                </dl>
                <div className="px-4 py-3 flex items-center gap-2">
                  <span className={`${microLabel} me-auto`}>{isAr ? 'تنزيل' : 'Download'}</span>
                  <button
                    onClick={() => handleDownload('txt')}
                    className="flex items-center gap-1.5 border border-neutral-300 px-3 py-1.5 text-[11px] hover:border-neutral-900 transition-colors cursor-pointer"
                  >
                    <Download className="w-3 h-3" />
                    TXT
                  </button>
                  <button
                    onClick={() => handleDownload('doc')}
                    className="flex items-center gap-1.5 border border-neutral-300 px-3 py-1.5 text-[11px] hover:border-neutral-900 transition-colors cursor-pointer"
                  >
                    <Download className="w-3 h-3" />
                    DOC
                  </button>
                </div>
              </footer>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center p-6">
              <p className="text-sm text-neutral-400 max-w-xs text-center leading-relaxed">
                {isAr
                  ? 'سيظهر النص المستخرج هنا بعد رفع المستند.'
                  : 'The extracted text will appear here once a document is processed.'}
              </p>
            </div>
          )}
        </section>
      </div>

      {/* Sample documents */}
      <section className="border-t border-neutral-200 pt-6">
        <div className="flex items-baseline justify-between gap-4 mb-4">
          <h2 className={microLabel}>{isAr ? 'مستندات تجريبية' : 'Sample documents'}</h2>
          <p className="text-[11px] text-neutral-500">
            {isAr ? 'لا تملك صورة؟ جرّب إحدى هذه' : 'No document at hand? Try one of these'}
          </p>
        </div>

        <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          {DEMO_DOCUMENTS.map((doc) => (
            <li key={doc.id}>
              <button
                onClick={() => loadDemo(doc.file, isAr ? doc.titleAr : doc.titleEn)}
                disabled={isLoading}
                className="group w-full text-start border border-neutral-200 hover:border-neutral-900 disabled:opacity-40 transition-colors cursor-pointer"
              >
                <div className="aspect-4/5 overflow-hidden bg-neutral-100 border-b border-neutral-200">
                  <img
                    src={doc.file}
                    alt={isAr ? doc.titleAr : doc.titleEn}
                    loading="lazy"
                    className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-[filter] duration-300"
                  />
                </div>
                <div className="p-3">
                  <span className="block text-xs font-medium leading-tight">
                    {isAr ? doc.titleAr : doc.titleEn}
                  </span>
                  <span className="block text-[11px] text-neutral-500 mt-1 leading-tight">
                    {isAr ? doc.noteAr : doc.noteEn}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
};
