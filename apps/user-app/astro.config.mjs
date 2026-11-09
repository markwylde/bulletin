import { defineConfig } from "astro/config";

// The SSR adapter is chosen by spike S1 (ADR 0008); the shell builds statically for now.
export default defineConfig({
  output: "static",
});
