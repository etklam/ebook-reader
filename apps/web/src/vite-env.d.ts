// The one piece of Vite's injected environment this app reads. Declared by
// hand rather than pulling in `vite/client` through tsconfig `types`: that
// package also declares every asset-import module and the HMR API, none of
// which is used here, and the repo already prefers a narrow ambient file (see
// styles.d.ts) over a broad one.
interface ImportMeta {
  readonly env: {
    /** true in `vite build` output, false under the dev server */
    readonly PROD: boolean;
    readonly DEV: boolean;
  };
}
