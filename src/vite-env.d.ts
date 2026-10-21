/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The Pack Battles server, e.g. https://api.pokejam.example. Unset: Pack Battles runs as an offline preview. */
  readonly VITE_API_URL?: string;
}
