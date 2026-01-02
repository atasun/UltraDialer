export type ProviderSupport = "elevenlabs" | "openai" | "both";

export interface LanguageOption {
  value: string;
  label: string;
  providers: ProviderSupport;
}

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { value: "en", label: "English", providers: "both" },
  { value: "es", label: "Spanish", providers: "both" },
  { value: "fr", label: "French", providers: "both" },
  { value: "de", label: "German", providers: "both" },
  { value: "it", label: "Italian", providers: "both" },
  { value: "pt", label: "Portuguese", providers: "both" },
  { value: "zh", label: "Chinese", providers: "both" },
  { value: "ja", label: "Japanese", providers: "both" },
  { value: "ko", label: "Korean", providers: "both" },
  { value: "hi", label: "Hindi", providers: "both" },
  { value: "ar", label: "Arabic", providers: "both" },
  { value: "ru", label: "Russian", providers: "both" },
  { value: "nl", label: "Dutch", providers: "both" },
  { value: "pl", label: "Polish", providers: "both" },
  { value: "sv", label: "Swedish", providers: "both" },
  { value: "no", label: "Norwegian", providers: "both" },
  { value: "da", label: "Danish", providers: "both" },
  { value: "fi", label: "Finnish", providers: "both" },
  { value: "el", label: "Greek", providers: "both" },
  { value: "cs", label: "Czech", providers: "both" },
  { value: "sk", label: "Slovak", providers: "both" },
  { value: "hu", label: "Hungarian", providers: "both" },
  { value: "ro", label: "Romanian", providers: "both" },
  { value: "bg", label: "Bulgarian", providers: "both" },
  { value: "hr", label: "Croatian", providers: "both" },
  { value: "uk", label: "Ukrainian", providers: "both" },
  { value: "tr", label: "Turkish", providers: "both" },
  { value: "id", label: "Indonesian", providers: "both" },
  { value: "ms", label: "Malay", providers: "both" },
  { value: "vi", label: "Vietnamese", providers: "both" },
  { value: "fil", label: "Filipino", providers: "both" },
  { value: "ta", label: "Tamil", providers: "openai" },
  { value: "th", label: "Thai", providers: "openai" },
  { value: "he", label: "Hebrew", providers: "openai" },
  { value: "bn", label: "Bengali", providers: "openai" },
  { value: "te", label: "Telugu", providers: "openai" },
  { value: "mr", label: "Marathi", providers: "openai" },
  { value: "gu", label: "Gujarati", providers: "openai" },
  { value: "kn", label: "Kannada", providers: "openai" },
  { value: "ml", label: "Malayalam", providers: "openai" },
  { value: "pa", label: "Punjabi", providers: "openai" },
  { value: "ur", label: "Urdu", providers: "openai" },
  { value: "fa", label: "Persian", providers: "openai" },
  { value: "sw", label: "Swahili", providers: "openai" },
  { value: "af", label: "Afrikaans", providers: "openai" },
  { value: "ca", label: "Catalan", providers: "openai" },
  { value: "lt", label: "Lithuanian", providers: "openai" },
  { value: "lv", label: "Latvian", providers: "openai" },
  { value: "sl", label: "Slovenian", providers: "openai" },
  { value: "et", label: "Estonian", providers: "openai" },
];

export function getLanguageLabel(value: string): string {
  const lang = SUPPORTED_LANGUAGES.find(l => l.value === value);
  return lang?.label || value;
}

export function isProviderSupported(value: string, provider: "elevenlabs" | "openai"): boolean {
  const lang = SUPPORTED_LANGUAGES.find(l => l.value === value);
  if (!lang) return false;
  return lang.providers === "both" || lang.providers === provider;
}
