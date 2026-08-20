import { DemoDocument } from '../types';

// Real scanned pages served from /samples, offered to visitors who don't have
// a document of their own at hand. Ordered from easiest to hardest.
export const DEMO_DOCUMENTS: DemoDocument[] = [
  {
    id: 'demo-quote',
    file: '/samples/Image2.jpeg',
    titleEn: 'Handwritten quote',
    titleAr: 'اقتباس بخط اليد',
    noteEn: 'Neat handwriting, ruled paper',
    noteAr: 'خط واضح على ورق مسطر'
  },
  {
    id: 'demo-verse',
    file: '/samples/Image3.jpeg',
    titleEn: 'Poetry lines',
    titleAr: 'أبيات شعرية',
    noteEn: 'Cursive with margin notes',
    noteAr: 'خط متصل مع ملاحظات جانبية'
  },
  {
    id: 'demo-naskh',
    file: '/samples/Image4.jpeg',
    titleEn: 'Naskh calligraphy',
    titleAr: 'خط النسخ',
    noteEn: 'Full tashkeel, framed page',
    noteAr: 'تشكيل كامل وصفحة مؤطرة'
  },
  {
    id: 'demo-letter',
    file: '/samples/Image1.jpeg',
    titleEn: 'Personal letter',
    titleAr: 'رسالة شخصية',
    noteEn: 'Fast cursive, dense lines',
    noteAr: 'خط سريع وأسطر متقاربة'
  },
  {
    id: 'demo-essay',
    file: '/samples/Image6.jpeg',
    titleEn: 'Essay page',
    titleAr: 'صفحة مقال',
    noteEn: 'Long multi-paragraph page',
    noteAr: 'صفحة طويلة متعددة الفقرات'
  },
  {
    id: 'demo-hardest',
    file: '/samples/hardest.jpeg',
    titleEn: 'Hardest sample',
    titleAr: 'الأصعب',
    noteEn: 'Rushed script, uneven lighting',
    noteAr: 'خط مستعجل وإضاءة متفاوتة'
  }
];
