import { defineConfig } from "vite";

// The companion deploys to GitHub Pages under a project path
// (https://<user>.github.io/<repo>/), so assets must be referenced relatively.
// A relative base keeps the build portable across user/project Pages and local
// `vite preview` without hard-coding the repository name.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
  },
});
