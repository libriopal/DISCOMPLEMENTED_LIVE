/// <reference types="vite/client" />

// vite/client.d.ts declares `*.wasm` and `*.wasm?init` but not the `?url`
// suffix used by workers/esbuild.worker.ts to get the esbuild binary's URL.
declare module '*.wasm?url' {
  const src: string;
  export default src;
}

// @babel/standalone ships no type declarations and there's no
// @types/babel__standalone in this offline-friendly dependency set — this
// covers the one function components/PreviewFrame.tsx actually calls.
declare module '@babel/standalone' {
  export interface BabelTransformOptions {
    presets?: string[];
    filename?: string;
  }
  export interface BabelTransformResult {
    code: string | null;
  }
  export function transform(
    code: string,
    options?: BabelTransformOptions
  ): BabelTransformResult;
}
