export interface SpeechSettings {
  stt: string;
  sttLanguage: string;
  tts: string;
  ttsLanguage: string;
  voice: string;
}
export interface SpeechQuery {
  search: string;
  offset: number;
  limit: number;
}
export interface SpeechPage<T> {
  items: T[];
  total: number;
}
export interface SpeechEngine {
  id: string;
  name: string;
  languages: string[];
}
export interface SpeechVoice {
  id: string;
  name: string;
}
