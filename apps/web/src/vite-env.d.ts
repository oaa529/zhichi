/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LLM_ADAPTER?: string;
  readonly VITE_LLM_BASE_URL?: string;
  readonly VITE_LLM_API_KEY?: string;
  readonly VITE_LLM_MODEL?: string;
  readonly VITE_LLM_TIMEOUT_MS?: string;
  readonly VITE_LLM_MAX_RETRIES?: string;
  readonly VITE_LLM_TEMPERATURE?: string;
  readonly VITE_LLM_MAX_TOKENS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
