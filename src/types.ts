export type ScriptType =
  | 'islamic_script'
  | 'ruqah'
  | 'naskh'
  | 'diwani'
  | 'thuluth'
  | 'kufic'
  | 'modern_handwriting'
  | 'printed_standard'
  | 'mixed';

export type DocumentCategory =
  | 'handwritten_note'
  | 'invoice_receipt'
  | 'medical_prescription'
  | 'legal_contract'
  | 'id_official_doc'
  | 'historical_manuscript'
  | 'general_document';

export interface OCRResult {
  documentId: string;
  processingTimeMs: number;
  primaryScript: ScriptType;
  documentCategory: DocumentCategory;
  language: 'ar' | 'ar-en' | 'ar-fr' | 'multilingual';
  overallConfidence: number;
  fullTextArabic: string;
  metadata: {
    charCount: number;
    wordCount: number;
  };
  remaining?: number;
}

export interface UsageInfo {
  remaining: number;
  dailyLimit: number;
  resetAtIso: string;
}

export interface DemoDocument {
  id: string;
  file: string;
  titleEn: string;
  titleAr: string;
  noteEn: string;
  noteAr: string;
}
