import { LanguageCode, WhisperSettings } from '../utils/whisper/types';

// Suggested models for autocomplete.
// We use the onnx-community/* exports: they ship clean per-dtype ONNX files that
// work with transformers.js v4 + onnxruntime-web (the legacy Xenova/* q8 files
// crash the new QDQ graph optimizer).
export const SUGGESTED_MODELS = [
  'onnx-community/whisper-tiny.en',
  'onnx-community/whisper-base.en',
  'onnx-community/whisper-small.en',
  'onnx-community/whisper-tiny',
  'onnx-community/whisper-base',
  'onnx-community/whisper-small',
  'onnx-community/whisper-large-v3-turbo'
];

// Maps legacy Xenova/* model IDs to their onnx-community/* equivalents.
// Only the variants known to exist on onnx-community are remapped; anything else
// (custom IDs, distil-whisper, etc.) is left untouched.
const WHISPER_MODEL_MIGRATION: Record<string, string> = {
  'Xenova/whisper-tiny.en': 'onnx-community/whisper-tiny.en',
  'Xenova/whisper-tiny': 'onnx-community/whisper-tiny',
  'Xenova/whisper-base.en': 'onnx-community/whisper-base.en',
  'Xenova/whisper-base': 'onnx-community/whisper-base',
  'Xenova/whisper-small.en': 'onnx-community/whisper-small.en',
  'Xenova/whisper-small': 'onnx-community/whisper-small',
};

export function migrateWhisperModelId(modelId: string): string {
  return WHISPER_MODEL_MIGRATION[modelId] ?? modelId;
}

// Language name mapping
export const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  en: 'English',
  zh: 'Chinese',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
  ko: 'Korean',
  fr: 'French',
  ja: 'Japanese',
  pt: 'Portuguese',
  tr: 'Turkish',
  pl: 'Polish',
  ca: 'Catalan',
  nl: 'Dutch',
  ar: 'Arabic',
  sv: 'Swedish',
  it: 'Italian',
  id: 'Indonesian',
  hi: 'Hindi',
  fi: 'Finnish',
  vi: 'Vietnamese',
  he: 'Hebrew',
  uk: 'Ukrainian',
  el: 'Greek',
  ms: 'Malay',
  cs: 'Czech',
  ro: 'Romanian',
  da: 'Danish',
  hu: 'Hungarian',
  ta: 'Tamil',
  no: 'Norwegian',
  th: 'Thai',
  ur: 'Urdu',
  hr: 'Croatian',
  bg: 'Bulgarian',
  lt: 'Lithuanian',
  la: 'Latin',
  mi: 'Maori',
  ml: 'Malayalam',
  cy: 'Welsh',
  sk: 'Slovak',
  te: 'Telugu',
  fa: 'Persian',
  lv: 'Latvian',
  bn: 'Bengali',
  sr: 'Serbian',
  az: 'Azerbaijani',
  sl: 'Slovenian',
  kn: 'Kannada',
  et: 'Estonian',
  mk: 'Macedonian',
  br: 'Breton',
  eu: 'Basque',
  is: 'Icelandic',
  hy: 'Armenian',
  ne: 'Nepali',
  mn: 'Mongolian',
  bs: 'Bosnian',
  kk: 'Kazakh',
  sq: 'Albanian',
  sw: 'Swahili',
  gl: 'Galician',
  mr: 'Marathi',
  pa: 'Punjabi',
  si: 'Sinhala',
  km: 'Khmer',
  sn: 'Shona',
  yo: 'Yoruba',
  so: 'Somali',
  af: 'Afrikaans',
  oc: 'Occitan',
  ka: 'Georgian',
  be: 'Belarusian',
  tg: 'Tajik',
  sd: 'Sindhi',
  gu: 'Gujarati',
  am: 'Amharic',
  yi: 'Yiddish',
  lo: 'Lao',
  uz: 'Uzbek',
  fo: 'Faroese',
  ht: 'Haitian Creole',
  ps: 'Pashto',
  tk: 'Turkmen',
  nn: 'Nynorsk',
  mt: 'Maltese',
  sa: 'Sanskrit',
  lb: 'Luxembourgish',
  my: 'Myanmar',
  bo: 'Tibetan',
  tl: 'Tagalog',
  mg: 'Malagasy',
  as: 'Assamese',
  tt: 'Tatar',
  haw: 'Hawaiian',
  ln: 'Lingala',
  ha: 'Hausa',
  ba: 'Bashkir',
  jw: 'Javanese',
  su: 'Sundanese'
};

export interface LanguageInfo {
  code: LanguageCode;
  name: string;
}

export const AVAILABLE_LANGUAGES: LanguageInfo[] = Object.entries(LANGUAGE_NAMES).map(([code, name]) => ({
  code: code as LanguageCode,
  name
}));

export function getDefaultWhisperSettings(): WhisperSettings {
  return {
    modelId: 'onnx-community/whisper-tiny.en',
    quantized: true,
    chunkDurationMs: 5000,
    device: 'wasm',
  };
}

export function getLanguageInfo(languageCode: LanguageCode): LanguageInfo {
  const info = AVAILABLE_LANGUAGES.find(l => l.code === languageCode);
  if (!info) {
    throw new Error(`Unknown language code: ${languageCode}`);
  }
  return info;
}
