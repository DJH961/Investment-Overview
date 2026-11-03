/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in the public demo-only build (GitHub Pages); absent otherwise. */
  readonly VITE_DEMO_ONLY?: string;
}
