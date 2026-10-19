/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_AUTH0_DOMAIN: string
  readonly VITE_AUTH0_CLIENT_ID: string
  readonly VITE_GEMINI_API_KEY: string
  readonly VITE_DEFAULT_MODEL: string
  // add more environment variables as needed
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
